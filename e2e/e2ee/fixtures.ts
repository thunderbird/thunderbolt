/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test as base } from '@playwright/test'
import { closeE2eeDb } from './db'

// `Record<never, never>` (not `Record<string, never>`) avoids a string index
// signature that would otherwise type the worker fixture's value as `never`.
type TestFixtures = Record<never, never>
type WorkerFixtures = {
  e2eeDatabaseLifecycle: void
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  e2eeDatabaseLifecycle: [
    // Playwright requires the first fixture arg to use object destructuring, even
    // when no fixtures are consumed.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use()
      await closeE2eeDb()
    },
    { auto: true, scope: 'worker' },
  ],
})

export { expect }
