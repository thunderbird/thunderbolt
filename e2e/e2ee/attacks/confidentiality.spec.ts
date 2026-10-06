/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Baseline confidentiality oracles — the regression test for `oracles.ts`
 * itself, and the floor every attack spec in this directory builds on.
 *
 * Claim under test: C1 (zero-knowledge server) in
 * docs/architecture/e2ee-threat-model.md.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/confidentiality.spec.ts
 */

import { test } from '../fixtures'
import { getTaskIds, waitForEncryptedSetting, waitForNewEncryptedTasks, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, createTask, enableTasks, loginViaConsumerOtp } from '../helpers'
import {
  expectAllColumnsCiphertext,
  expectEncryptedColumnsMapMatchesSchema,
  expectNoPlaintextOnServer,
} from '../oracles'

test.describe.serial('E2EE confidentiality (C1)', () => {
  test('no user plaintext is readable anywhere on the server', async ({ page }) => {
    // Fails loudly if the map has drifted from the schema — otherwise the scans
    // below would silently stop covering the column that drifted.
    await expectEncryptedColumnsMapMatchesSchema()

    const email = createE2eeEmail()
    const marker = crypto.randomUUID()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, `redteam ${marker}`)
    await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)

    // Targeted: content we know was written must not be readable, under any
    // account — a marker landing on someone else's row is worse than a leak.
    await expectNoPlaintextOnServer([marker])

    // Blanket: needs no knowledge of what was written, so it catches a
    // write-through whose plaintext we never thought to look for. Skips the
    // documented `serverAuthoredPlaintextColumns` divergences.
    await expectAllColumnsCiphertext(userId)
  })
})
