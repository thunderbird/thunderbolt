/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runs only against a deployed preview.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: /preview-smoke\.spec\.ts$/,
  retries: 1,
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PREVIEW_APP_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
})
