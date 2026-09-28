/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it, onTestFinished } from 'bun:test'
import path from 'path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadConfigFromFile, resolveConfig } from 'vite'

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

    const config = await resolveConfig(
      { root: ROOT, configFile: false, server: loaded.config.server, plugins: [] },
      'serve',
    )
    serverFsConfig = config.server.fs
    resolvedAllow = serverFsConfig.allow.map((p) => path.resolve(p))
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

for (const scenario of ['resolve', 'serve', 'build and preview']) {
  it(`PowerSync assets: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'thunderbolt-vite-assets-'))
    // Vite and its real timers run outside the frontend test preloads.
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import config from ${JSON.stringify(path.join(import.meta.dir, 'vite.config.ts'))}
         import pkg from ${JSON.stringify(path.join(import.meta.dir, 'package.json'))}
         import { build, createServer, preview, resolveConfig } from ${JSON.stringify(import.meta.resolve('vite'))}
         import assert from 'node:assert/strict'
         import { existsSync } from 'node:fs'
         import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
         import { dirname, join } from 'node:path'
         import { fileURLToPath } from 'node:url'
         const source = dirname(fileURLToPath(${JSON.stringify(import.meta.resolve('@powersync/web/umd'))}))
         const scenario = ${JSON.stringify(scenario)}
         process.chdir(${JSON.stringify(root)})
         const options = {
           configFile: false,
           plugins: config.plugins.filter(plugin => plugin?.name === 'copy-powersync-assets'),
           server: { host: '127.0.0.1', port: 0, hmr: false },
           preview: { host: '127.0.0.1', port: 0 },
           logLevel: 'silent',
         }
         const workers = (await readdir(join(source, 'worker'))).filter(name => name.endsWith('.js'))
         assert(workers.includes('WASQLiteDB.umd.js'))
         const wasm = (await readdir(source)).filter(name => name.endsWith('.wasm'))
         assert(wasm.length > 0)
         const assets = [...workers.map(name => 'worker/' + name), ...wasm]
         /** Verify the server returns the real worker and dependency chunks, not HTML fallbacks. */
         const checkServer = async (server) => {
           for (const name of assets) {
             const response = await fetch(new URL('/@powersync/' + name, server.resolvedUrls.local[0]))
             assert.equal(response.status, 200)
             assert.match(response.headers.get('content-type'), name.endsWith('.wasm') ? /wasm/ : /javascript/)
             assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(source, name)))
           }
         }
         if (scenario === 'resolve') {
           await resolveConfig(options, 'serve')
           await resolveConfig(options, 'build')
           assert(!existsSync('public/@powersync'), 'config resolution must not copy source assets')
         } else if (scenario === 'serve') {
           await writeFile('package.json', JSON.stringify({ scripts: pkg.scripts }))
           // Exercise the real dev/start preparation without leaving a CLI server process.
           for (const command of ['dev', 'start']) {
             await rm('public', { recursive: true, force: true })
             const prepare = Bun.spawn([process.execPath, 'run', command, '--', '--help'], { stdout: 'ignore', stderr: 'inherit' })
             assert.equal(await prepare.exited, 0)
             assert(existsSync('public/@powersync/worker/WASQLiteDB.umd.js'), command + ' must prepare assets')
           }
           const server = await createServer(options)
           try {
             await server.listen()
             await checkServer(server)
           } finally {
             await server.close()
           }
         } else {
           await writeFile('index.html', '<!doctype html><title>PowerSync asset build</title>')
           await build(options)
           for (const name of assets) {
             assert.deepEqual(await readFile(join('dist/@powersync', name)), await readFile(join(source, name)))
           }
           await rm('public', { recursive: true, force: true })
           const server = await preview(options)
           try {
             assert(!existsSync('public'), 'preview must not mutate source assets')
             await checkServer(server)
           } finally {
             await server.close()
           }
         }`,
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
    onTestFinished(async () => {
      child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    })
    expect(await child.exited).toBe(0)
  })
}
