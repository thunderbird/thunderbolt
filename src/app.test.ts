import { readFileSync } from 'fs'
import { describe, expect, it } from 'bun:test'

/**
 * Dev-only routes (/message-simulator, /settings/dev-settings) must be
 * guarded by `import.meta.env.DEV` so Vite eliminates them from
 * production builds. These tests read the source to catch regressions.
 */
describe('dev-only routes are excluded from production builds', () => {
  const appSource = readFileSync(new URL('./app.tsx', import.meta.url), 'utf-8')

  const devRoutes = ['message-simulator', 'dev-settings'] as const

  for (const route of devRoutes) {
    it(`${route} route is guarded by import.meta.env.DEV`, () => {
      const routePattern = new RegExp(`import\\.meta\\.env\\.DEV\\s*&&\\s*\\(?\\s*<Route[^>]*path=["']${route}["']`)
      expect(appSource).toMatch(routePattern)
    })

    it(`${route} page uses lazy() import`, () => {
      const lazyPattern = new RegExp(
        `import\\.meta\\.env\\.DEV\\s*\\?\\s*lazy\\(\\(\\)\\s*=>\\s*import\\([^)]*${route}`,
      )
      expect(appSource).toMatch(lazyPattern)
    })
  }
})
