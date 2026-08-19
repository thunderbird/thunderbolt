/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Dedicated Playwright config for the PowerSync + Postgres E2EE suite. Separate
 * from the root `playwright.config.ts` (which runs auth/gate/artifact projects on
 * ephemeral pglite backends) because these specs need a REAL Postgres + a running
 * PowerSync service. Boot the harness and run via scripts/run-e2ee-powersync.sh,
 * which starts powersync-service/docker-compose.yml and passes E2E_POSTGRES_PORT
 * / E2E_POWERSYNC_PORT through to this config and to e2e/e2ee/db.ts.
 */

import { defineConfig, devices } from '@playwright/test'
import { getOrgKmsTestKeypair } from './e2e/e2ee/kms-test-keypair'

// Org KMS escrow POC (org-escrow.spec.ts): the public half configures
// ORG_KMS_ESCROW_STATIC_PUBLIC_KEY below. See kms-test-keypair.ts for why
// this is cached to a temp file rather than a plain module-level constant.
const orgKmsTestKeypair = getOrgKmsTestKeypair()

const isCI = !!process.env.CI
const frontendPort = 1423
const backendPort = 8004
// A second, GATED backend sharing the same Postgres + secrets, with
// MIN_APP_VERSION pinned above any real build so the version gate is genuinely
// tripped. migration.spec.ts probes its /v1/powersync/token to assert a below-min
// client is 426'd (the hard-cutover guard, plan §6.2). The gate runs before auth,
// so the probe needs no session.
const gatedBackendPort = 8005
const gateMinAppVersion = '99.0.0'
const postgresPort = process.env.E2E_POSTGRES_PORT ?? '5434'
const powersyncPort = process.env.E2E_POWERSYNC_PORT ?? '8081'

const databaseUrl = `postgresql://postgres:postgres@localhost:${postgresPort}/postgres`

const backendEnv = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  APP_URL: `http://localhost:${frontendPort}`,
  AUTH_MODE: 'consumer',
  BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
  BETTER_AUTH_URL: `http://localhost:${port}`,
  CORS_ORIGINS: `http://localhost:${frontendPort}`,
  DATABASE_DRIVER: 'postgres',
  DATABASE_URL: databaseUrl,
  // Org key escrow POC: enabled for the whole suite — a single global
  // toggle exercised transparently by every AK-producing flow (org-escrow.spec.ts
  // asserts the escrow envelope itself; the rest of the suite incidentally proves
  // it doesn't regress the existing device model). E2EE itself has no flag —
  // it's unconditionally on for every backend.
  ORG_KMS_ESCROW_ENABLED: 'true',
  ORG_KMS_ESCROW_STATIC_PUBLIC_KEY: orgKmsTestKeypair.publicKeyBase64,
  PORT: String(port),
  POSTHOG_API_KEY: '',
  POWERSYNC_JWT_KID: 'powersync-dev',
  POWERSYNC_JWT_SECRET: 'powersync-dev-secret-change-in-production',
  POWERSYNC_URL: `http://localhost:${powersyncPort}`,
  RATE_LIMIT_ENABLED: 'false',
  TRUSTED_ORIGINS: `http://localhost:${frontendPort}`,
  WAITLIST_AUTO_APPROVE_DOMAINS: 'e2e.test',
  WAITLIST_ENABLED: 'true',
  ...extra,
})

export default defineConfig({
  testDir: './e2e/e2ee',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? 'blob' : 'list',
  // These are heavy multi-device flows (build + several OTP logins with cooldowns
  // + cross-device sync waits) run serially on a constrained CI runner; 120s per
  // test is too tight once the migration itself succeeds and the follower/recovery
  // phases run.
  timeout: 240_000,
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
      // Serve a production BUILD via `vite preview`, NOT the dev server. This
      // suite boots several browser contexts, and the vite dev server compiles
      // the wa-sqlite worker + WASM on demand — too slowly under CI load for a
      // second context to initialize its local DB within the app's 30s
      // dbReadyTimeout, which surfaced as "Failed to initialize app". A prebuilt
      // bundle serves those assets statically so DB init is fast and
      // deterministic (and the whole suite runs faster).
      command: `bun run build && bun run preview -- --port ${frontendPort} --strictPort`,
      url: `http://localhost:${frontendPort}`,
      reuseExistingServer: false,
      // Covers the one-time production build + preview startup on a cold runner.
      timeout: 240_000,
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
      env: backendEnv(backendPort),
    },
    {
      // Self-contained pglite backend: the below-min probe hits the version gate
      // (which runs BEFORE auth/DB), so this needs no shared Postgres — keeping it
      // off the harness DB avoids a concurrent migrate race with the main backend.
      command: 'cd backend && bun run src/index.ts',
      url: `http://localhost:${gatedBackendPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        APP_URL: `http://localhost:${frontendPort}`,
        AUTH_MODE: 'consumer',
        BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
        BETTER_AUTH_URL: `http://localhost:${gatedBackendPort}`,
        CORS_ORIGINS: `http://localhost:${frontendPort}`,
        DATABASE_DRIVER: 'pglite',
        PORT: String(gatedBackendPort),
        POSTHOG_API_KEY: '',
        RATE_LIMIT_ENABLED: 'false',
        TRUSTED_ORIGINS: `http://localhost:${frontendPort}`,
        MIN_APP_VERSION: gateMinAppVersion,
      },
    },
  ],
})
