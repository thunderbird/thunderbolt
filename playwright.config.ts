/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test'
import { idpCertSingleLine } from './e2e/saml-test-certs'

const isCI = !!process.env.CI
const mockOidcPort = process.env.MOCK_OIDC_PORT ?? '9876'
const mockSamlPort = process.env.MOCK_SAML_PORT ?? '9877'

// OIDC: frontend 1421, backend 8000
const oidcVitePort = 1421
const oidcBackendPort = 8000

// SAML: frontend 1422, backend 8001
const samlVitePort = 1422
const samlBackendPort = 8001

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
      },
    },
    // --- OIDC backend ---
    {
      command: 'cd backend && bun run dev',
      url: `http://localhost:${oidcBackendPort}/v1/health`,
      reuseExistingServer: !isCI,
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
      reuseExistingServer: !isCI,
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
