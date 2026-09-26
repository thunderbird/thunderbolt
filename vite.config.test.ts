/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'bun:test'
import path from 'path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, loadConfigFromFile } from 'vite'

const ROOT = path.resolve(import.meta.dirname)

/**
 * Vite's `server.fs` configuration must use a strict allowlist so the dev
 * server only exposes frontend source code. Without this, the `@fs` endpoint
 * leaks backend source, config, and other sensitive files to any HTTP client.
 *
 * See: https://vitejs.dev/config/server-options.html#server-fs-allow
 */
describe('vite server.fs allowlist', () => {
  let resolvedAllow: string[]
  let serverFsConfig: { strict: boolean; allow: string[] }

  beforeAll(async () => {
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      path.join(ROOT, 'vite.config.ts'),
    )
    if (!loaded) throw new Error('Failed to load vite config')

    // Create a minimal server to resolve the full fs config (merges Vite defaults)
    let server
    try {
      server = await createServer({ root: ROOT, configFile: false, server: loaded.config.server, plugins: [] })
      serverFsConfig = server.config.server.fs
      resolvedAllow = serverFsConfig.allow.map((p) => path.resolve(p))
    } finally {
      await server?.close()
    }
  })

  it('enables strict filesystem access', () => {
    expect(serverFsConfig.strict).toBe(true)
  })

  it('defines an explicit allow list', () => {
    expect(resolvedAllow).toBeArray()
    expect(resolvedAllow.length).toBeGreaterThan(0)
  })

  const assertDirectoryNotAllowed = (dirName: string) => {
    it(`does not allow the ${dirName} directory`, () => {
      const targetDir = path.resolve(ROOT, dirName)

      for (const allowed of resolvedAllow) {
        // Check both directions: the sensitive dir is an allowed path (or child),
        // AND no allowed path is a subdirectory of the sensitive dir.
        const isAllowed =
          allowed === targetDir || targetDir.startsWith(allowed + path.sep) || allowed.startsWith(targetDir + path.sep)
        expect(isAllowed).toBe(false)
      }
    })
  }

  assertDirectoryNotAllowed('backend')
  assertDirectoryNotAllowed('deploy')

  it('does not allow the project root directly (would expose everything)', () => {
    for (const allowed of resolvedAllow) {
      expect(allowed).not.toBe(ROOT)
    }
  })

  it('allows frontend source directories', () => {
    expect(resolvedAllow).toContain(path.resolve(ROOT, 'src'))
    expect(resolvedAllow).toContain(path.resolve(ROOT, 'shared'))
    expect(resolvedAllow).toContain(path.resolve(ROOT, 'public'))
    expect(resolvedAllow).toContain(path.resolve(ROOT, 'node_modules'))
  })
})

for (const command of ['serve', 'build']) {
  it(`PowerSync worker assets exist before Vite initializes ${command}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'thunderbolt-vite-assets-'))
    try {
      // A subprocess isolates cwd and Vite from the frontend test preloads.
      const child = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `import config from ${JSON.stringify(path.join(import.meta.dir, 'vite.config.ts'))}
           import { resolveConfig } from ${JSON.stringify(import.meta.resolve('vite'))}
           process.chdir(${JSON.stringify(root)})
           await resolveConfig({
             configFile: false,
             plugins: config.plugins.filter(plugin => plugin?.name === 'copy-powersync-assets'),
           }, ${JSON.stringify(command)})`,
        ],
        {
          cwd: import.meta.dir,
          env: {
            ...process.env,
            PATH: `${path.join(import.meta.dir, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`,
          },
          stdout: 'ignore',
          stderr: 'inherit',
        },
      )
      expect(await child.exited).toBe(0)
      expect(await Bun.file(path.join(root, 'public/@powersync/worker/WASQLiteDB.umd.js')).exists()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
