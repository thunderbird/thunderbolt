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

// Min-version gate: frontend 1423, backend 8004. A dedicated OIDC-mode backend
// with MIN_APP_VERSION pinned ABOVE the build-fixed VITE_APP_VERSION so every
// gated request from this build is genuinely below the server minimum. Backend
// env is per-webServer and fixed for its life, so simulating an out-of-date
// client requires its own server — the real-gate scenarios (hard-block +
// exempt-route coverage) run against it; the runtime-flip/header-coverage
// scenarios reuse the ungated OIDC frontend via `loginViaOidc`.
const gateVitePort = 1423
const gateBackendPort = 8004
const gateMinAppVersion = '99.0.0'

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
    {
      // Min-version gate specs. baseURL points at the UNGATED OIDC frontend
      // (:1421) so `loginViaOidc` (relative `/`) drives the run-normally,
      // runtime-flip, and header-coverage scenarios; the hard-block scenario
      // navigates to the GATED frontend (:1423) by absolute URL and the
      // exempt-route scenario probes the gated backend (:8004) directly.
      name: 'min-version-gate',
      testMatch: /min-version-gate\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${oidcVitePort}`,
      },
    },
    {
      // Self-contained real-browser tests for the artifact harness (drive the wrapped
      // HTML in a sandboxed iframe on about:blank) — no auth server, backend, or baseURL.
      // Anchor to a leading `/` and forbid `/` in the name so the match is the FILENAME,
      // not the worktree dir "feat-html-artifact-tool" (which also contains "artifact-").
      name: 'artifact',
      testMatch: /\/artifact-[^/]*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
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
      // Locally reuse a warm e2e backend across runs for fast iteration; it binds a
      // dedicated port (8002), distinct from the dev backend on :8000, so a stray dev
      // server is never reused. In CI always boot fresh.
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        PORT: String(oidcBackendPort),
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
      // Locally reuse a warm e2e backend across runs — see OIDC backend comment above.
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        PORT: String(samlBackendPort),
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
    // --- Min-version-gate frontend ---
    {
      command: `bun run dev -- --port ${gateVitePort}`,
      url: `http://localhost:${gateVitePort}`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        VITE_AUTH_MODE: 'sso',
        VITE_SKIP_ONBOARDING: 'true',
        // Point this frontend at the gated backend so its `/config` fetch returns
        // `minAppVersion` and the client renders <UpgradeRequired> from a real
        // server response (the hard-block scenario).
        VITE_THUNDERBOLT_CLOUD_URL: `http://localhost:${gateBackendPort}/v1`,
      },
    },
    // --- Min-version-gate backend ---
    {
      command: 'cd backend && bun run --watch src/index.ts',
      url: `http://localhost:${gateBackendPort}/v1/health`,
      // Locally reuse a warm e2e backend across runs — see OIDC backend comment above.
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        PORT: String(gateBackendPort),
        AUTH_MODE: 'oidc',
        OIDC_CLIENT_ID: 'thunderbolt-app',
        OIDC_CLIENT_SECRET: 'thunderbolt-dev-secret',
        OIDC_ISSUER: `http://localhost:${mockOidcPort}`,
        BETTER_AUTH_URL: `http://localhost:${gateBackendPort}`,
        BETTER_AUTH_SECRET: 'e2e-test-secret-at-least-32-characters-long',
        APP_URL: `http://localhost:${gateVitePort}`,
        CORS_ORIGINS: `http://localhost:${gateVitePort}`,
        TRUSTED_ORIGINS: `http://localhost:${gateVitePort},http://localhost:${mockOidcPort}`,
        RATE_LIMIT_ENABLED: 'false',
        DATABASE_DRIVER: 'pglite',
        // The lever under test: pin the server minimum above the build-fixed
        // VITE_APP_VERSION so this build is always below-min against this backend.
        MIN_APP_VERSION: gateMinAppVersion,
      },
    },
  ],
})
