/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test'

const isCI = !!process.env.CI
const frontendPort = 1423
const backendPort = 8004
const postgresPort = process.env.E2E_POSTGRES_PORT ?? '5434'
const powersyncPort = process.env.E2E_POWERSYNC_PORT ?? '8081'

export default defineConfig({
  testDir: './e2e/e2ee',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? 'blob' : 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${frontendPort}`,
    permissions: ['clipboard-read', 'clipboard-write'],
    screenshot: 'only-on-failure',
    storageState: undefined,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `bun run dev -- --port ${frontendPort}`,
      url: `http://localhost:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_AUTH_MODE: 'consumer',
        VITE_SKIP_ONBOARDING: 'true',
        VITE_THUNDERBOLT_CLOUD_URL: `http://localhost:${backendPort}/v1`,
      },
    },
    {
      command: 'cd backend && bun run src/index.ts',
      url: `http://localhost:${backendPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        APP_URL: `http://localhost:${frontendPort}`,
        AUTH_MODE: 'consumer',
        BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
        BETTER_AUTH_URL: `http://localhost:${backendPort}`,
        CORS_ORIGINS: `http://localhost:${frontendPort}`,
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: `postgresql://postgres:postgres@localhost:${postgresPort}/postgres`,
        E2EE_ENABLED: 'true',
        PORT: String(backendPort),
        POSTHOG_API_KEY: '',
        POWERSYNC_JWT_KID: 'powersync-dev',
        POWERSYNC_JWT_SECRET: 'powersync-dev-secret-change-in-production',
        POWERSYNC_URL: `http://localhost:${powersyncPort}`,
        RATE_LIMIT_ENABLED: 'false',
        TRUSTED_ORIGINS: `http://localhost:${frontendPort}`,
        WAITLIST_AUTO_APPROVE_DOMAINS: 'e2e.test',
        WAITLIST_ENABLED: 'true',
      },
    },
  ],
})
