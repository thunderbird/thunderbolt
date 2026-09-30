/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Replays the QA agent's repro specs against a stack that is already running. Run it through
// `scripts/qa/verify.ts replay`, which passes only the specs that passed the lint: a bare run would also
// execute the rejected ones. The specs sign in with `loginViaEmailCode`, which navigates to the base URL and
// reaches the backend the frontend was built against, so the stack must be a consumer pair: backend with
// NODE_ENV=test (fixed sign-in code) and WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.test.
import { defineConfig, devices } from '@playwright/test'

const outDir = process.env.QA_OUT ?? 'qa-out'

export default defineConfig({
  testMatch: /\/repro\/[\w-]+\.spec\.ts$/,
  outputDir: `${outDir}/replay`,
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: '50%',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    // The consumer pair in playwright.config.ts. c1 specs switch to the onboarding build on 1425 with test.use().
    baseURL: 'http://localhost:1424',
    video: 'on',
    trace: 'on',
  },
  projects: [
    { name: 'candidates', testDir: outDir },
    // The stack health check that must pass in the same run.
    { name: 'control', testDir: 'qa/control' },
  ],
})
