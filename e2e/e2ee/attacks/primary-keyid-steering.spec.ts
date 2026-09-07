/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-876 — server `primary_key_id:"v1"` steers new writes onto the legacy CK
 * (C4/C5, adversary A2 + a legacy-CK holder, Medium). **Claim: new writes must
 * never be encrypted under the absorbed, never-rotating legacy `"v1"` key.**
 *
 * The client stores the server-supplied `primary_key_id` verbatim (`applyKeyring`
 * → `storePrimaryKeyId`, src/services/encryption.ts:351). On a migrated account
 * the keyring carries a `"v1"` slot — the absorbed legacy CK, readable by any
 * holder of a v1-era phrase or device. If a malicious server reports
 * `primary_key_id:"v1"`, `codec.encode` resolves that slot and emits
 * `__enc:v2:v1:…` for every new write (src/db/encryption/codec.ts:262-276), so
 * future data is sealed under a key that never rotates and that revocation never
 * touches — defeating forward secrecy for new writes. (v2-native accounts have no
 * `"v1"` slot and fail closed, so the scope is migrated accounts.)
 *
 * Capability audit: the only attacker power exercised is A2 rewriting one field
 * of the metadata response. The v1 seed + migration is test setup that
 * reproduces a realistic migrated account, not an attacker privilege.
 *
 * Nuance (worth a note on the ticket): the steer is not instantaneous within a
 * session. `applyKeyring` persists the server's `primary_key_id` to IndexedDB,
 * but `invalidateKeyringCache` KEEPS the in-memory primary pointer, so a context
 * that already cached the real primary keeps using it. The persisted `"v1"`
 * takes effect on the next FRESH context — a reload or a new tab, which a real
 * user does constantly. This spec reproduces that: it lets `prime` persist
 * `"v1"`, waits until IndexedDB holds it, then writes from a fresh load.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — a new
 * write's wire key_id must NOT be the legacy `"v1"` — and is tagged `test.fail()`
 * because the vuln is open today, so that assertion fails now. When THU-876 is
 * fixed (reject `legacyKeyId` as primary at the client store sites and in the
 * backend `setPrimaryKeyId`), new writes route through a real key again, the
 * assertion passes, and Playwright flags the unexpected pass → drop the
 * `test.fail()` tag for a permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/primary-keyid-steering.spec.ts
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  getTaskCiphertext,
  getTaskIds,
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
import { legacyKeyId } from '../../../shared/e2ee-types'

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

test.describe.serial('THU-876 — primary_key_id steering', () => {
  test('a server-reported primary_key_id:v1 routes new writes onto the legacy CK', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const marker = `steered-${crypto.randomUUID()}`

    // Build a real migrated account: register the device, seed a legacy v1
    // account around its keys, then run the seamless upgrade so the keyring
    // holds both "0" (new primary) and the absorbed "v1" slot.
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await registerDeviceOnly(page)
    const [migratorKeys] = await waitForDeviceKeys(userId, 1)
    await seedV1Account(userId, [migratorKeys])
    await runSeamlessMigration(page)
    await waitForSchemeV2(userId, ['0', legacyKeyId])
    await enableTasks(page)

    // A2 reports the legacy slot as the primary. Reload so `prime` →
    // `stageKeyring` → `applyKeyring` persists it, then wait until IndexedDB
    // actually holds "v1" — that guarantees the next fresh context (the write
    // below) reads the steered primary rather than a cached real one.
    await overrideEncryptionMetadata(page.context(), { primary_key_id: legacyKeyId })
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()
    await expect.poll(() => readPersistedPrimaryKeyId(page), { timeout: 30_000 }).toBe(legacyKeyId)

    const before = await getTaskIds(userId)
    await createTask(page, marker)
    const [rowId] = [...(await waitForNewEncryptedTasks(userId, before)).map((row) => row.id)]
    const parsed = parseWireValue(await getTaskCiphertext(rowId))
    expect(parsed).toBeTruthy()

    // SECURE assertion: the new write must not be sealed under the legacy CK.
    // Fails today (key_id is "v1"); passes once THU-876 rejects it as primary.
    expect(parsed!.keyId).not.toBe(legacyKeyId)
  })
})
