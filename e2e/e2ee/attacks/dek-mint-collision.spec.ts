/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-871 — DEK-mint collision: a planted `key_id` makes a revocation brick the
 * account (C15/C5, adversary A6 / A2, High). **Claim: minting a DEK must always
 * produce a key the account actually holds — a `wrapped_keys` row nobody minted
 * must never become the primary.**
 *
 * `rotateDEK` allocated the next key_id as `String(Math.max(...numericIds) + 1)`
 * over ids parsed straight out of the fetched keyring. A row labelled with 17+
 * digits makes `max + 1 === max` under IEEE-754 — verified numerically: every
 * value in `[2^53, 1e21)` collides on the FIRST rotation — so the "new" id was
 * one that already existed. `insertWrappedKey` was `ON CONFLICT DO NOTHING`, so
 * the freshly minted wrapped DEK was silently discarded while the route still
 * answered `200 { key_id }` and `setPrimaryKeyId` moved the primary onto the
 * planted row. The client then encrypted under a DEK the server did not hold;
 * the next keyring sync overwrote its only local copy, orphaning everything
 * written in the window. And because every later rotation recomputed the same
 * colliding id, the account could never mint a working primary again —
 * `codec.encode` fails closed, so the outcome is a permanent account-wide write
 * lockout rather than a leak.
 *
 * It fires on the VICTIM'S OWN revoke flow, which is the sharp part: the
 * standard response to an A6 compromise is "revoke the device and change the
 * recovery phrase", and this is what permanently disables both.
 *
 * The fix has two halves, both exercised here. The allocator claims the SMALLEST
 * UNUSED canonical counter instead of highest-plus-one (`nextPrimaryKeyId`), so
 * its result is by construction an id that is not on the keyring and cannot be
 * pushed outside the grammar the server enforces — a planted row becomes a gap
 * to step over rather than an input to arithmetic. Both labels planted below
 * defeat a highest-plus-one allocator, in different ways, so this spec is green
 * only under smallest-unused. The mint then moved INSIDE the rotate transaction
 * (`newPrimaryKey`), where the server independently validates the grammar,
 * rejects an id that already exists, and asserts a row was really inserted — so
 * a collision aborts the whole rotation instead of being swallowed.
 *
 * The planted rows deliberately carry a byte-copy of DEK `"0"`'s own
 * `wrapped_key`, so they OPEN under the account's AK. That isolates this claim
 * from the separate poison-pill defect (`attacks/rotation-poison-pill.spec.ts`),
 * which an unopenable row triggers inside `rewrapKeyring` — otherwise this spec
 * would be gated on both fixes and would fail inside the revoke helper rather
 * than at an assertion.
 *
 * Capability audit: one INSERT into `wrapped_keys`. That is A2's own DB power,
 * and it was also A6's through `POST /encryption/keys` — a same-origin script on
 * a trusted device reads the AK from IndexedDB, derives the canary secret and
 * calls that route with the bound session and a valid 'rotate' proof. (That
 * route no longer exists, which is why the spec plants the row directly; a
 * malicious server retains the capability regardless.) The revocation itself is
 * performed by the legitimate user through the real UI.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C
 * expected-failure while the vuln was open; once the grammar landed the run
 * reported "Expected to fail, but passed" and the `test.fail()` tag was retired.
 * Non-vacuity is what assertions 2 and 3 buy: "the primary is not the planted
 * id" would also hold if the DEK rotation had silently stopped happening, so the
 * spec additionally pins that a key was really minted (a blob absent from the
 * pre-revoke snapshot), that the AK rotation completed (`key_version` advanced),
 * and that the account can still write and read afterwards.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/dek-mint-collision.spec.ts
 */

import {
  getEncryptionServerSnapshot,
  getTaskIds,
  plantWrappedKey,
  waitForConsumedChallenge,
  waitForDeviceState,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import { expect, test } from '../fixtures'
import { isMintableKeyId } from '@shared/e2ee-types'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createIsolatedDevice,
  createTask,
  enableTasks,
  finishAdditionalDeviceSetup,
  getDeviceId,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  startAdditionalDeviceSetup,
  waitForTasksPreference,
} from '../helpers'

/**
 * The two shapes a hostile label can take against a highest-plus-one allocator.
 * Both are planted, so the spec is green only under smallest-unused allocation.
 *
 * - **17 digits** — the true minimum that collides on the FIRST rotation, not
 *   the 21 the ticket originally cited. `parseInt` gives 1e16, past 2^53, so
 *   `+ 1` is absorbed and `String()` returns the identical string (exponent
 *   notation only begins at 1e21). Defeats an unfiltered `max + 1`.
 * - **15 nines** — itself grammar-valid, so filtering cannot ignore it, and
 *   `max + 1` walks off the end of the grammar to a 16-digit id the server's own
 *   mint validation rejects. Defeats a grammar-filtered `max + 1`, blocking
 *   every revocation instead of colliding.
 */
const plantedKeyIds = ['10000000000000000', '9'.repeat(15)]

test.describe.serial('A6/A2 — DEK-mint collision', () => {
  test('a planted key_id cannot capture the primary DEK pointer', async ({ browser, page }) => {
    const email = createE2eeEmail()
    const taskAfter = `Written after the revoke ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    // A second trusted device, so there is something to revoke.
    const victim = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(victim.page, email)
      await startAdditionalDeviceSetup(victim.page)
      const victimDeviceId = await getDeviceId(victim.page)
      await waitForDeviceState(userId, victimDeviceId, (state) => state.approvalPending)

      const notification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
      await expect(notification).toBeVisible({ timeout: 30_000 })
      await notification.getByRole('button', { name: 'Approve' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click()
      await waitForDeviceState(userId, victimDeviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(victim.page)
      await waitForTasksPreference(victim.page, userId)

      // Plant both hostile labels. Each blob is a byte-copy of DEK "0"'s own
      // wrapping, so the rows are openable under the account AK and only the
      // allocator is under test.
      const before = await getEncryptionServerSnapshot(userId)
      for (const keyId of plantedKeyIds) {
        await plantWrappedKey(userId, keyId, before.wrappedKeys['0']!)
      }
      const blobsBefore = new Set(Object.values(before.wrappedKeys))

      await revokeTrustedDevice(page, 'Firefox on macOS')
      await waitForConsumedChallenge(userId, 'revoke')
      await waitForDeviceState(userId, victimDeviceId, (state) => !state.trusted && state.revokedAt !== null)
      await expect
        .poll(async () => (await getEncryptionServerSnapshot(userId)).keyVersion, { timeout: 30_000 })
        .toBeGreaterThan(before.keyVersion)

      const after = await getEncryptionServerSnapshot(userId)

      // 1. The primary must not have landed on either planted row, and must be
      //    an id the server would itself accept as mintable.
      expect(plantedKeyIds).not.toContain(after.primaryKeyId)
      expect(isMintableKeyId(after.primaryKeyId)).toBe(true)

      // 2. A DEK was really minted: the primary's wrapping is a value that did
      //    not exist before the revoke. Without this, assertion 1 would pass
      //    just as well if the DEK rotation had quietly stopped happening.
      expect(after.wrappedKeys[after.primaryKeyId]).toBeDefined()
      expect(blobsBefore.has(after.wrappedKeys[after.primaryKeyId]!)).toBe(false)

      // 3. And the account can still write — the lockout this bug caused was
      //    `codec.encode` failing closed on an unresolvable primary.
      const taskIdsBefore = await getTaskIds(userId)
      await createTask(page, taskAfter)
      const newRows = await waitForNewEncryptedTasks(userId, taskIdsBefore)
      expect(newRows.length).toBeGreaterThan(0)
      expect(newRows[0]!.item).toMatch(new RegExp(`^__enc:v2:${after.primaryKeyId}:`))
      expect(newRows[0]!.item).not.toContain(taskAfter)
      await expect(page.getByText(taskAfter, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await victim.context.close()
    }
  })
})
