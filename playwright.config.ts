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
  workers: isCI ? 2 : 1,
  reporter: isCI ? 'blob' : 'list',
  timeout: 30_000,
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
      testMatch: /oidc/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${oidcVitePort}`,
      },
    },
    {
      name: 'saml',
      testMatch: /saml/,
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
      timeout: 30_000,
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
      command: 'cd backend && bun run dev',
      url: `http://localhost:${oidcBackendPort}/v1/health`,
      // Backend env is test-specific (mock IdP, e2e secrets, rate limit off) — never reuse a
      // dev backend that happened to bind :8000. Playwright will fail fast if the port is taken.
      reuseExistingServer: false,
      timeout: 30_000,
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
      },
    },
    // --- SAML frontend ---
    {
      command: `bun run dev -- --port ${samlVitePort}`,
      url: `http://localhost:${samlVitePort}`,
      reuseExistingServer: !isCI,
      timeout: 30_000,
      env: {
        VITE_AUTH_MODE: 'sso',
        VITE_SKIP_ONBOARDING: 'true',
        VITE_THUNDERBOLT_CLOUD_URL: `http://localhost:${samlBackendPort}/v1`,
      },
    },
    // --- SAML backend ---
    {
      command: 'cd backend && bun run dev',
      url: `http://localhost:${samlBackendPort}/v1/health`,
      // Backend env is test-specific — see OIDC backend comment above.
      reuseExistingServer: false,
      timeout: 30_000,
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
      },
    },
  ],
})
