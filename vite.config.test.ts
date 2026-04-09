import { beforeAll, describe, expect, it } from 'bun:test'
import path from 'path'
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
          allowed === targetDir ||
          targetDir.startsWith(allowed + path.sep) ||
          allowed.startsWith(targetDir + path.sep)
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
