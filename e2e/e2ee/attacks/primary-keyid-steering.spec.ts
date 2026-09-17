/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-876 — server `primary_key_id:"v1"` steers new writes onto the legacy CK
 * (C4/C5 standalone, **C1** chained with THU-877; adversary A2 + a legacy-CK
 * holder, High). **Claim: new writes must never be encrypted under the
 * absorbed, never-rotating legacy `"v1"` key.**
 *
 * The client used to store the server-supplied `primary_key_id` verbatim
 * (`applyKeyring` → `storePrimaryKeyId`) and `codec.encode` used whatever came
 * back. On a migrated account the keyring carries a `"v1"` slot — the absorbed
 * legacy CK, decrypt-only by design: it never rotates, revocation never re-wraps
 * it, and any holder of a v1-era phrase or device opens it (the v1 mnemonic WAS
 * the raw CK). So a malicious server reporting `primary_key_id:"v1"` got every
 * new write sealed under it: correctly formatted and AAD-bound (`__enc:v2:v1:…`),
 * but outside the key hierarchy revocation controls. Chained with THU-877 the
 * server also CHOOSES that key, so it needs no second party and reads the
 * plaintext itself.
 *
 * **THU-890 closed this at the source.** The served `metadata.primary_key_id`
 * (delivered on `GET /encryption/canary`) is now *advisory and never stored*:
 * the pointer's only trusted source is the sealed AK envelope, whose pointer
 * shares the AK's auth tag (`adoptEnvelopeAK`, `encryption.ts:697-712`). On the
 * fast path — the stored AK still opens the keyring, i.e. same epoch, which is
 * the case here — `stageKeyring` never consults the metadata pointer at all
 * (`encryption.ts:807-818`). So a `primary_key_id:"v1"` steer is not even
 * refused; it is simply *ignored*, and the primary already in force survives.
 * (The non-mintable refusal at `applyKeyring` still guards a pointer that
 * arrives sealed into a JUST-ADOPTED envelope — `encryption.ts:767-772` — but
 * that path is not reachable from a metadata field.)
 *
 * Capability audit: the only attacker power exercised is A2 rewriting one field
 * of the canary response. The v1 seed + migration is test setup that reproduces
 * a realistic migrated account, not an attacker privilege.
 *
 * Polarity: asserts the SECURE behavior, green under THU-890. **Assertion 1 is
 * the non-vacuity anchor** — it reads the served canary and proves the poison
 * really is being handed to the client, so a silent containment below cannot be
 * "the steer was never delivered". Assertion 2 pins the *mechanism*: the pointer
 * is IGNORED (stored pointer untouched, and the refusal log does NOT fire — that
 * would mean an adopted-envelope pointer, a different path). Assertions 3-4 pin
 * that the write was ROUTED under the real primary, not stalled: a spec that
 * only checked `keyId !== "v1"` would also pass if uploads had quietly stopped.
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

test.describe.serial('THU-876 — primary_key_id steering', () => {
  test('an advisory primary_key_id:v1 is ignored, and writes stay on the real primary', async ({ page }) => {
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

    // Under THU-890 the steer is not REFUSED, it is IGNORED, so the old refusal
    // log must NOT appear — assertion 2 pins that mechanism.
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })

    // A2 reports the legacy slot as the primary. Reload so `prime` →
    // `stageKeyring` processes the poisoned canary.
    await overrideEncryptionMetadata(page.context(), { primary_key_id: legacyKeyId })
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()

    // 1. Non-vacuity anchor: the poison really is being served and consumed —
    //    the canary the client reads for its pointer carries "v1".
    const served = await encryptionApiRequest(page, '/encryption/canary')
    expect((served.body as { primary_key_id?: string }).primary_key_id).toBe(legacyKeyId)

    // 2. THU-890 closure: the advisory pointer is IGNORED. The stored pointer is
    //    untouched (still the real primary), and the non-mintable refusal never
    //    fires — that guard is for a pointer sealed into an adopted envelope, a
    //    path a metadata field cannot reach.
    expect(await readPersistedPrimaryKeyId(page)).toBe(initialKeyId)
    expect(consoleErrors.some((line) => line.includes('refused a non-mintable primary key_id'))).toBe(false)

    // 3. The write is ROUTED, not stalled: it lands under the real primary.
    const before = await getTaskIds(userId)
    await createTask(page, marker)
    const [rowId] = [...(await waitForNewEncryptedTasks(userId, before)).map((row) => row.id)]
    const parsed = parseWireValue(await getTaskCiphertext(rowId))
    expect(parsed).toBeTruthy()
    expect(parsed!.keyId).not.toBe(legacyKeyId)
    expect(parsed!.keyId).toBe(initialKeyId)

    // 4. And it round-trips, so ignoring the steer cost the user nothing.
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
