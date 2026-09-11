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
 * (`applyKeyring` → `storePrimaryKeyId`, src/services/encryption.ts:464-472),
 * and `codec.encode` used whatever came back (src/db/encryption/codec.ts:
 * 262-275). On a migrated account the keyring carries a `"v1"` slot — the
 * absorbed legacy CK, decrypt-only by design: it never rotates, revocation
 * never re-wraps it, and any holder of a v1-era phrase or device opens it (the
 * v1 mnemonic WAS the raw CK). So a malicious server reporting
 * `primary_key_id:"v1"` got every new write sealed under it: correctly formatted
 * and AAD-bound (`__enc:v2:v1:…`), but outside the key hierarchy revocation
 * controls. Chained with THU-877 the server also CHOOSES that key, so it needs
 * no second party and reads the plaintext itself.
 *
 * Capability audit: the only attacker power exercised is A2 rewriting one field
 * of the metadata response. The v1 seed + migration is test setup that
 * reproduces a realistic migrated account, not an attacker privilege.
 *
 * Nuance: the steer is not instantaneous within a session. `applyKeyring`
 * persists the pointer while `invalidateKeyringCache` KEEPS the in-memory one,
 * so a context that already cached the real primary keeps using it and the
 * poison bites on the next FRESH context — a reload or a new tab, which a real
 * user hits constantly. That durability is the attack: it outlives the response
 * that delivered it.
 *
 * The fix refuses any pointer outside the mint grammar (`isMintableKeyId`,
 * THU-871 — `legacyKeyId` is deliberately outside it) at three points: the door
 * (`applyKeyring` skips it and keeps the primary already in force; the upload
 * path defers instead), the drawer (`storePrimaryKeyId` refuses to persist it),
 * and the point of use (`codec.encode` fails closed on a pointer written around
 * that API, which is what stops a transient in-origin compromise from becoming
 * a permanent steer). The server-side half was already closed by THU-871: the
 * only route that writes this column validates the id against `keyIdPattern`.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C
 * expected-failure while the vuln was open; the `test.fail()` tag was retired
 * once the fix landed. **Assertion 1 is the non-vacuity anchor** — it proves the
 * poisoned response really was processed and refused, rather than the write
 * simply never seeing it. The original setup step (poll IndexedDB until it holds
 * `"v1"`) is unreachable post-fix by construction, which is exactly the point,
 * so it is replaced by the refusal signal; that couples this spec to a log
 * substring on purpose. Assertions 3-4 then pin that the write was ROUTED, not
 * stalled: a spec that only checked `keyId !== "v1"` would also pass if uploads
 * had quietly stopped.
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
  test('a server-reported primary_key_id:v1 is refused, and writes stay on the real primary', async ({ page }) => {
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

    // Collect the client's own report of what it refused. Attached before the
    // reload below, and kept across navigations for this page.
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })

    // A2 reports the legacy slot as the primary. Reload so `prime` →
    // `stageKeyring` → `applyKeyring` processes the poisoned response.
    await overrideEncryptionMetadata(page.context(), { primary_key_id: legacyKeyId })
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()

    // 1. Non-vacuity anchor: the steer was seen and rejected, not missed.
    await expect
      .poll(() => consoleErrors.some((line) => line.includes('refused a non-mintable primary key_id')), {
        timeout: 30_000,
      })
      .toBe(true)

    // 2. Nothing hostile became durable local state — the primary already in
    //    force survived, so the next fresh context reads a legitimate pointer.
    expect(await readPersistedPrimaryKeyId(page)).toBe(initialKeyId)

    // 3. The write is ROUTED, not stalled: it lands under the real primary.
    const before = await getTaskIds(userId)
    await createTask(page, marker)
    const [rowId] = [...(await waitForNewEncryptedTasks(userId, before)).map((row) => row.id)]
    const parsed = parseWireValue(await getTaskCiphertext(rowId))
    expect(parsed).toBeTruthy()
    expect(parsed!.keyId).not.toBe(legacyKeyId)
    expect(parsed!.keyId).toBe(initialKeyId)

    // 4. And it round-trips, so the refusal cost the user nothing.
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
