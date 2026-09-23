/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test'
import baseConfig from './playwright.config'

const isMac = (process.env.NIGHTLY_PLATFORM ?? process.platform) === 'darwin'
process.env.E2E_NIGHTLY_WEBKIT_PERSISTENT = String(isMac)
const browsers = isMac
  ? [
      { name: 'webkit-desktop', device: devices['Desktop Safari'] },
      { name: 'webkit-iphone', device: devices['iPhone 13'] },
    ]
  : [
      { name: 'chromium-desktop', device: devices['Desktop Chrome'] },
      { name: 'chromium-mobile', device: devices['Pixel 7'] },
      { name: 'firefox-desktop', device: devices['Desktop Firefox'] },
      { name: 'firefox-mobile', device: { ...devices['Desktop Firefox'], viewport: { width: 390, height: 844 } } },
    ]

const webServers = Array.isArray(baseConfig.webServer) ? baseConfig.webServer : [baseConfig.webServer]

/** Require real container endpoints before running the Linux Nightly suite. */
const requiredNightlyEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for Linux Nightly tests`)
  return value
}

const databaseEnv = isMac
  ? undefined
  : {
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: requiredNightlyEnv('NIGHTLY_DATABASE_URL'),
      POWERSYNC_URL: requiredNightlyEnv('NIGHTLY_POWERSYNC_URL'),
      POWERSYNC_JWT_SECRET: 'enterprise-thunderbolt-powersync-jwt-default-secret',
      POWERSYNC_JWT_KID: 'enterprise-powersync',
      SKIP_MIGRATIONS: 'true',
    }

export default defineConfig({
  ...baseConfig,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...baseConfig.use,
    // The CI upload step strips network records and action parameters from traces.
    trace: { mode: 'retain-on-failure', snapshots: false, screenshots: false, sources: false, attachments: false },
    video: 'retain-on-failure',
    screenshot: 'off',
    storageState: undefined,
  },
  projects: baseConfig.projects?.flatMap((project) =>
    browsers.map(({ name, device }) => ({
      ...project,
      name: `${project.name}-${name}`,
      use: { ...project.use, ...device, baseURL: project.use?.baseURL },
    })),
  ),
  webServer: webServers
    .filter((server) => server !== undefined)
    .map((server) => {
      if (!server.command?.startsWith('cd backend')) return server
      return {
        ...server,
        env: {
          ...server.env,
          ...databaseEnv,
          ANTHROPIC_API_KEY:
            server.env?.AUTH_MODE === 'consumer' ? 'e2e-fake-provider-key' : (process.env.ANTHROPIC_API_KEY ?? ''),
          TINFOIL_API_KEY: process.env.TINFOIL_API_KEY ?? '',
          TINFOIL_ENCLAVE_URL: process.env.TINFOIL_ENCLAVE_URL ?? '',
          EXA_API_KEY: process.env.EXA_API_KEY ?? '',
        },
      }
    }),
})
