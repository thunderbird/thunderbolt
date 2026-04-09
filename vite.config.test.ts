import { describe, expect, it } from 'bun:test'

/**
 * Vite dev server filesystem access controls.
 *
 * The Vite @fs endpoint can serve any file inside the workspace root.
 * `server.fs.deny` must block backend source code, deployment configs, and
 * other sensitive directories from being served — otherwise they are
 * accessible at e.g. http://localhost:5173/@fs/app/backend/src/config/settings.ts
 *
 * See: https://vitejs.dev/config/server-options#server-fs-deny
 */
const deniedDirectories = [
  'backend',
  'deploy',
  '.thunderbot',
  'powersync-service',
  'scripts',
  '.claude',
  '.github',
  'src-tauri',
] as const

describe('vite server.fs.deny', async () => {
  const configModule = await import('./vite.config.ts')
  const config = configModule.default

  // defineConfig returns a UserConfig object (or a function, but ours is an object)
  const deny = config?.server?.fs?.deny as string[] | undefined

  it('is an array with entries', () => {
    expect(deny).toBeDefined()
    expect(Array.isArray(deny)).toBe(true)
    expect(deny!.length).toBeGreaterThanOrEqual(4)
  })

  it('includes default .env protection', () => {
    expect(deny).toContainEqual('.env')
    expect(deny).toContainEqual('.env.*')
  })

  it('includes default certificate protection', () => {
    expect(deny).toContainEqual('*.{crt,pem}')
  })

  for (const dir of deniedDirectories) {
    it(`blocks /${dir}/ via glob pattern`, () => {
      const hasGlob = deny!.some(
        (p) => p === `**/${dir}/**` || p === `${dir}/**` || p === `**/${dir}`,
      )
      expect(hasGlob).toBe(true)
    })
  }
})
