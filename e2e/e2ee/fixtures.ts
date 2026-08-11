/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test as base } from '@playwright/test'
import { closeE2eeDb } from './db'

type WorkerFixtures = {
  e2eeDatabaseLifecycle: void
}

export const test = base.extend<Record<string, never>, WorkerFixtures>({
  e2eeDatabaseLifecycle: [
    async ({}, use) => {
      await use()
      await closeE2eeDb()
    },
    { auto: true, scope: 'worker' },
  ],
})

export { expect }
