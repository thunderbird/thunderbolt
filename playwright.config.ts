import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
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
  webServer: {
    command: 'VITE_BYPASS_WAITLIST=true VITE_SKIP_ONBOARDING=true bun run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      VITE_BYPASS_WAITLIST: 'true',
      VITE_SKIP_ONBOARDING: 'true',
    },
  },
})
