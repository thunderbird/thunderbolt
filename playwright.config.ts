import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI
const mockOidcPort = process.env.MOCK_OIDC_PORT ?? '9876'
// Use a dedicated Vite port to avoid conflicts with dev server.
// Backend uses the standard 8000 to match the default cloud_url setting.
const e2eVitePort = 1421

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : 1,
  reporter: isCI ? 'blob' : 'list',
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${e2eVitePort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Fresh storage state per test to avoid stale IndexedDB/OPFS data
    storageState: undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `bun run dev -- --port ${e2eVitePort}`,
      url: `http://localhost:${e2eVitePort}`,
      reuseExistingServer: !isCI,
      timeout: 30_000,
      env: {
        VITE_AUTH_MODE: 'oidc',
        VITE_SKIP_ONBOARDING: 'true',
      },
    },
    {
      command: 'cd backend && bun run dev',
      url: 'http://localhost:8000/v1/health',
      reuseExistingServer: !isCI,
      timeout: 30_000,
      env: {
        AUTH_MODE: 'oidc',
        OIDC_CLIENT_ID: 'thunderbolt-app',
        OIDC_CLIENT_SECRET: 'thunderbolt-dev-secret',
        OIDC_ISSUER: `http://localhost:${mockOidcPort}`,
        BETTER_AUTH_URL: 'http://localhost:8000',
        BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
        APP_URL: `http://localhost:${e2eVitePort}`,
        CORS_ORIGINS: `http://localhost:${e2eVitePort}`,
        TRUSTED_ORIGINS: `http://localhost:${e2eVitePort}`,
      },
    },
  ],
})
