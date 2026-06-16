/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test'
import { idpCertSingleLine } from './e2e/saml-test-certs'

const isCI = !!process.env.CI
const mockOidcPort = process.env.MOCK_OIDC_PORT ?? '9876'
const mockSamlPort = process.env.MOCK_SAML_PORT ?? '9877'

// OIDC: frontend 1421, backend 8002 (off :8000 so e2e doesn't collide with `make dev`)
const oidcVitePort = 1421
const oidcBackendPort = 8002

// SAML: frontend 1422, backend 8003 (off :8001 to keep both backends in their own band)
const samlVitePort = 1422
const samlBackendPort = 8003

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // One worker per shard: each CI runner already hosts 4 servers (2 Vite + 2
  // backend) on 4 vCPUs, so a second browser worker oversubscribes the box and
  // starves the cold first-navigation transpile. Parallelism comes from the 2
  // shards running as separate jobs.
  workers: 1,
  reporter: isCI ? 'blob' : 'list',
  // 60s per test: the heaviest specs (loginViaOidc SSO round-trip → lazy-route
  // navigation → form submit → PowerSync row) brush a 30s budget on a busy
  // 4-vCPU runner. expect floor at 10s for the same reason.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    storageState: undefined,
  },
  projects: [
    {
      name: 'oidc',
      // ACP + proxy specs use the OIDC mock IdP via `loginViaOidc`, so they
      // belong in this project alongside the auth flow tests. Anchor to
      // `.spec.ts$` so non-spec helpers under e2e/ (mock-saml-idp.ts,
      // saml-test-certs.ts, helpers.ts) are never misclassified as test files.
      testMatch: /(?:oidc|acp-|proxy-).*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${oidcVitePort}`,
      },
    },
    {
      name: 'saml',
      // Anchor to `.spec.ts$` — a bare /saml/ also matched the helper files
      // (mock-saml-idp.ts, saml-test-certs.ts), making Playwright treat them as
      // test files and break `playwright test --list` ("test file should not
      // import test file").
      testMatch: /saml.*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${samlVitePort}`,
      },
    },
  ],
  webServer: [
    // --- OIDC frontend ---
    {
      command: `bun run dev -- --port ${oidcVitePort}`,
      url: `http://localhost:${oidcVitePort}`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        VITE_AUTH_MODE: 'sso',
        VITE_SKIP_ONBOARDING: 'true',
        // Explicit cloud URL so the frontend hits the test-mode OIDC backend on 8002,
        // not the dev backend on 8000 if one happens to be running.
        VITE_THUNDERBOLT_CLOUD_URL: `http://localhost:${oidcBackendPort}/v1`,
      },
    },
    // --- OIDC backend ---
    {
      // Bypass `bun run dev` (which goes through scripts/dev.sh — lives in stacked PR #862)
      command: 'cd backend && bun run --watch src/index.ts',
      url: `http://localhost:${oidcBackendPort}/v1/health`,
      // Backend env is test-specific (mock IdP, e2e secrets, rate limit off) — never reuse a
      // dev backend that happened to bind :8000. Playwright will fail fast if the port is taken.
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(oidcBackendPort),
        // Stable per-deployment UUID — required by the settings schema (no default). Locally,
        // `backend/.env` supplies one via `make doctor`, but CI inherits no such file, so we
        // pin a deterministic fixture here. Distinct from the SAML backend's id so the two
        // e2e backends model independent trust domains.
        SERVER_ID: 'e2e0e2e0-e2e0-4e2e-8e2e-e2e0e2e00001',
        AUTH_MODE: 'oidc',
        OIDC_CLIENT_ID: 'thunderbolt-app',
        OIDC_CLIENT_SECRET: 'thunderbolt-dev-secret',
        OIDC_ISSUER: `http://localhost:${mockOidcPort}`,
        BETTER_AUTH_URL: `http://localhost:${oidcBackendPort}`,
        BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
        APP_URL: `http://localhost:${oidcVitePort}`,
        CORS_ORIGINS: `http://localhost:${oidcVitePort}`,
        TRUSTED_ORIGINS: `http://localhost:${oidcVitePort},http://localhost:${mockOidcPort}`,
        RATE_LIMIT_ENABLED: 'false',
        DATABASE_DRIVER: 'pglite',
      },
    },
    // --- SAML frontend ---
    {
      command: `bun run dev -- --port ${samlVitePort}`,
      url: `http://localhost:${samlVitePort}`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        VITE_AUTH_MODE: 'sso',
        VITE_SKIP_ONBOARDING: 'true',
        VITE_THUNDERBOLT_CLOUD_URL: `http://localhost:${samlBackendPort}/v1`,
      },
    },
    // --- SAML backend ---
    {
      // Bypass `bun run dev` (which goes through scripts/dev.sh — lives in stacked PR #862)
      command: 'cd backend && bun run --watch src/index.ts',
      url: `http://localhost:${samlBackendPort}/v1/health`,
      // Backend env is test-specific — see OIDC backend comment above.
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(samlBackendPort),
        // Distinct from the OIDC backend's id — see comment there for why we pin a fixture.
        SERVER_ID: 'e2e0e2e0-e2e0-4e2e-8e2e-e2e0e2e00002',
        AUTH_MODE: 'saml',
        SAML_ENTRY_POINT: `http://localhost:${mockSamlPort}/saml/sso`,
        SAML_ENTITY_ID: 'e2e-saml-sp',
        SAML_IDP_ISSUER: `http://localhost:${mockSamlPort}`,
        SAML_CERT: idpCertSingleLine,
        BETTER_AUTH_URL: `http://localhost:${samlBackendPort}`,
        BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
        APP_URL: `http://localhost:${samlVitePort}`,
        CORS_ORIGINS: `http://localhost:${samlVitePort}`,
        TRUSTED_ORIGINS: `http://localhost:${samlVitePort},http://localhost:${mockSamlPort}`,
        RATE_LIMIT_ENABLED: 'false',
        DATABASE_DRIVER: 'pglite',
      },
    },
  ],
})
