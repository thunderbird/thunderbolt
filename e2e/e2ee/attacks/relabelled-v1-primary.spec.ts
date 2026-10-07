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
 * every THU-876 pointer gate passes. Under the old AES-KW wrapping (which binds
 * no key_id into the blob) the relabelled row unwrapped fine, and every new
 * write became a well-formed `__enc:v2:1:…` sealed under the legacy CK: the one
 * key that never rotates, that revocation exempts, and that every v1-era device
 * and pre-migration recovery phrase can open (the v1 mnemonic WAS that key).
 *
 * Two independent defenses now stand between A2 and the payoff, and this spec
 * exercises the outer one:
 *
 *   - **THU-890 (outer, what this spec witnesses).** The pointer's only trusted
 *     source is the sealed AK envelope; the served `metadata.primary_key_id` is
 *     advisory and never stored. On the fast path (the stored AK still opens the
 *     keyring — same epoch, the case here) `stageKeyring` never consults the
 *     metadata pointer (`encryption.ts:807-818`). So `primary_key_id:"1"` is
 *     IGNORED: the primary stays `"0"`, and no write is ever sealed under the
 *     relabelled slot. The steer simply does not land.
 *   - **The AAD binding (inner, distinct).** `wrapDEK` binds the key_id into the
 *     wrapped blob as AAD (`dekWrapAAD`, shared/e2ee-types.ts), so a blob created
 *     as `"v1"` fails the auth tag under any other label. This is the defense of
 *     record for a relabel that DOES reach the codec (e.g. sealed into an adopted
 *     envelope across a rotation), and it is witnessed at the unit level
 *     (`src/crypto/primitives.test.ts` "refuses to unwrap a blob under a
 *     different key_id"). Under THU-890 this metadata vector no longer reaches
 *     it, so the e2e assertion below is the 890 closure, not the AAD refusal.
 *
 * Overlap with THU-876 is deliberate: both now witness the same THU-890 mechanism
 * (advisory pointer ignored on the fast path). The distinct setup here is a
 * relabelled *genuine* blob under a mintable id, versus 876's direct `"v1"`
 * pointer — the two label-shapes A2 can try, both inert.
 *
 * Residual (THU-890, still distinct): A2 serving a genuinely OLD row under its
 * own honest label — a pointer rollback across a real rotation. That needs the
 * signed pointer attestation the AK envelope provides, which is exactly what
 * THU-890 installs.
 *
 * Polarity: asserts the SECURE behavior, green under THU-890. Assertion 1 is the
 * non-vacuity anchor (the relabelled pointer really is served); the positive
 * control proves the pipeline was live before the plant.
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
  encryptionApiRequest,
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
  test('a "v1" blob relabelled under key_id "1" cannot steer the primary', async ({ page }) => {
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
    // steer that fails below cannot be "sync was never working".
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

    // Fresh boot processes the poisoned keyring (prime → stageKeyring).
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()

    // 1. Non-vacuity anchor: the relabelled pointer really is served — the
    //    canary the client reads for its pointer carries "1".
    const served = await encryptionApiRequest(page, '/encryption/canary')
    expect((served.body as { primary_key_id?: string }).primary_key_id).toBe('1')

    // 2. THU-890 closure: the advisory pointer is IGNORED. Despite every
    //    label-based gate passing (grammar, AK witness, honest blob), the stored
    //    primary is untouched — it never moved off "0" onto the relabelled slot.
    expect(await readPersistedPrimaryKeyId(page)).toBe(initialKeyId)

    // 3. The write lands under the real primary and round-trips: the steer did
    //    not land, and the user is unaffected. (Nothing is ever sealed under the
    //    relabelled "1", so a legacy-CK holder gains nothing.)
    const before = await getTaskIds(userId)
    await createTask(page, attackMarker)
    const [attackRow] = await waitForNewEncryptedTasks(userId, before)
    expect(parseWireValue(attackRow.item)?.keyId).toBe(initialKeyId)
    await expect(page.getByText(attackMarker, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
