/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test'
import { getChromeLaunchOptions } from '../scripts/chrome'

/**
 * WCAG audit of a running Thunderbolt. Not part of CI or `bun run test`: run it by
 * hand with `bun run a11y`. See a11y/README.md.
 */
export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  testMatch: /.*\.audit\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: './.output',
  use: {
    baseURL: process.env.A11Y_BASE_URL ?? 'http://localhost:1420',
    ...devices['Desktop Chrome'],
    locale: 'en-US',
    launchOptions: getChromeLaunchOptions(),
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
})
