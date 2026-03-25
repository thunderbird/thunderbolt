import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI
const MOCK_OIDC_PORT = 9876

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
    baseURL: 'http://localhost:1420',
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
      command: 'bun run dev',
      url: 'http://localhost:1420',
      reuseExistingServer: !isCI,
      timeout: 30_000,
      env: {
        VITE_BYPASS_WAITLIST: 'true',
        VITE_SKIP_ONBOARDING: 'true',
        VITE_AUTH_MODE: 'oidc',
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
        OIDC_ISSUER: `http://localhost:${MOCK_OIDC_PORT}`,
        BETTER_AUTH_URL: 'http://localhost:8000',
      },
    },
  ],
})
