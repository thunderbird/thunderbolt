/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-893 — the account's own `"v1"` blob relabelled under a mintable key_id
 * steers new writes onto the legacy CK (C4/C5, adversary A2 + any legacy-CK
 * holder, High). **Claim: new writes must never be sealed under the absorbed,
 * never-rotating legacy `"v1"` key — even when the pointer naming it is
 * grammatically honest.**
 *
 * The attack that motivated this spec needs no forgery at all: A2 serves the
 * account's own genuine `"v1"` row a SECOND time under `key_id "1"` and reports
 * `primary_key_id: "1"`. Every label-based gate passes — the blob is
 * authentically wrapped under the real AK, the AK itself is untouched so
 * THU-869's DEK-0 witness never fires, and `"1"` is inside the mint grammar so
 * all three THU-876 pointer gates pass. Under the old AES-KW wrapping (which
 * binds no key_id into the blob) the relabelled row unwrapped fine, and every
 * new write became a well-formed `__enc:v2:1:…` sealed under the legacy CK: the
 * one key that never rotates, that revocation exempts, and that every v1-era
 * device and pre-migration recovery phrase can open (the v1 mnemonic WAS that
 * key).
 *
 * The fix is cryptographic, not a gate: `wrapDEK` binds the key_id into the
 * wrapped blob as AAD (`dekWrapAAD`, shared/e2ee-types.ts), and `unwrapDEK`
 * builds the AAD from the key_id the client is RESOLVING. A blob created as
 * `"v1"` therefore fails the auth tag under any other label, on every device,
 * with no local state and nothing for the server to withhold. (An earlier
 * client-side fix compared the primary DEK's material against the legacy CK; it
 * needed an anchor to compare against, and A2 disarmed it on post-migration
 * devices by simply withholding the `"v1"` slot. The AAD binding has no such
 * anchor and closes the withholding variant with the same stroke.)
 *
 * What the fix deliberately does NOT do: refuse the pointer at adoption. The
 * pointer is grammar-valid, so `applyKeyring` adopts it and the failure lands at
 * the point of use — `codec.encode` fails CLOSED and the upload retries. Under
 * an actively hostile A2 that is a write outage, which is accepted: A2 can
 * always cause one (serve any garbage blob), and refusing to move off a stale
 * key instead would hand back exactly the key a revoked device copied (C5).
 * Assertion 1 pins the adoption on purpose: it proves every label gate passed
 * and ONLY the cryptography stood between the attacker and the payoff.
 *
 * Residual (THU-890, distinct): A2 serving a genuinely OLD row under its own
 * honest label — a pointer rollback, not a relabel. No AAD can catch it because
 * nothing is mislabelled; it needs the signed pointer attestation.
 *
 * Polarity: asserts the SECURE behavior, green from birth — the AAD wrapping
 * ships in the same change as this spec. Flippability was proven at the unit
 * level (`src/crypto/primitives.test.ts` "refuses to unwrap a blob under a
 * different key_id"): reverting `wrapDEK` to AES-KW fails that test and flips
 * assertions 3–4 here.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/relabelled-v1-primary.spec.ts
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  getEncryptionServerSnapshot,
  getTaskIds,
  plantWrappedKey,
  waitForDeviceKeys,
  waitForNewEncryptedTasks,
  waitForSchemeV2,
  waitForUserId,
} from '../db'
import {
  createE2eeEmail,
  createTask,
  enableTasks,
  loginViaConsumerOtp,
  overrideEncryptionMetadata,
  registerDeviceOnly,
  runSeamlessMigration,
  seedV1Account,
} from '../helpers'
import { parseWireValue } from '../../../src/db/encryption/wire-format'
import { initialKeyId, legacyKeyId } from '../../../shared/e2ee-types'

/** Read the client's persisted primary key_id straight from IndexedDB. */
const readPersistedPrimaryKeyId = (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open('thunderbolt-keys')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const get = open.result.transaction('keys', 'readonly').objectStore('keys').get('thunderbolt_primary_key_id')
          get.onsuccess = () => resolve((get.result as string | undefined) ?? null)
          get.onerror = () => reject(get.error)
        }
      }),
  )

test.describe.serial('THU-893 — relabelled "v1" blob as the primary', () => {
  test('a "v1" blob served under key_id "1" cannot become a working primary', async ({ page }) => {
    const email = createE2eeEmail()
    const controlMarker = `pre-plant-${crypto.randomUUID()}`
    const attackMarker = `relabelled-${crypto.randomUUID()}`

    // Build a real migrated account: the keyring holds "0" (fresh primary) and
    // the absorbed "v1" slot this attack tries to re-serve under a new name.
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await registerDeviceOnly(page)
    const [migratorKeys] = await waitForDeviceKeys(userId, 1)
    await seedV1Account(userId, [migratorKeys])
    await runSeamlessMigration(page)
    await waitForSchemeV2(userId, [initialKeyId, legacyKeyId])
    await enableTasks(page)

    // Positive control: the pipeline routes and uploads before the plant, so a
    // silent containment below cannot be "sync was never working".
    const baselineBefore = await getTaskIds(userId)
    await createTask(page, controlMarker)
    const [controlRow] = await waitForNewEncryptedTasks(userId, baselineBefore)
    expect(parseWireValue(controlRow.item)?.keyId).toBe(initialKeyId)

    // A2's whole move, using only state the server already holds: duplicate the
    // account's own "v1" row under a mintable id and point the primary at it.
    const snapshot = await getEncryptionServerSnapshot(userId)
    const genuineV1Blob = snapshot.wrappedKeys[legacyKeyId]
    expect(genuineV1Blob).toBeTruthy()
    await plantWrappedKey(userId, '1', genuineV1Blob)
    await overrideEncryptionMetadata(page.context(), { primary_key_id: '1' })

    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })

    // Fresh boot processes the poisoned keyring (prime → stageKeyring →
    // applyKeyring).
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()

    // 1. The poison is fully ADOPTED — every label-based gate passed (grammar,
    //    AK witness, honest blob). This is the non-vacuity anchor: only the wrap
    //    AAD stands between the attacker and the payoff from here on.
    await expect.poll(() => readPersistedPrimaryKeyId(page), { timeout: 30_000 }).toBe('1')

    // 2. The write is attempted (renders locally — PowerSync is local-first).
    const baseline = await getTaskIds(userId)
    await createTask(page, attackMarker)
    await expect(page.getByText(attackMarker, { exact: true })).toBeVisible({ timeout: 30_000 })

    // 3. The codec refuses the relabelled DEK at the point of use: the blob was
    //    wrapped as "v1" and fails the auth tag under "1", so encode fails
    //    CLOSED and the upload retries instead of shipping anything.
    await expect
      .poll(() => consoleErrors.some((line) => line.includes('refusing to upload plaintext')), { timeout: 30_000 })
      .toBe(true)

    // 4. Containment: nothing new reaches the server — most importantly nothing
    //    a legacy-CK holder could open. The window is bounded and starts only
    //    after the refusal in (3) was observed, so it is not racing the upload.
    await page.waitForTimeout(5_000)
    const afterIds = await getTaskIds(userId)
    expect([...afterIds].filter((id) => !baseline.has(id))).toEqual([])
  })
})
