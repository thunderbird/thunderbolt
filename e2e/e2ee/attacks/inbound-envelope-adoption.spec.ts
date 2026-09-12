/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-869 — inbound AK-envelope adoption without a possession check (C2/C1/C9,
 * adversary A2, High). **Claim: an established v2 device must not adopt a
 * server-supplied Account Key it cannot tie back to a server-independent
 * anchor.**
 *
 * `adoptEnvelopeAK` (`src/services/encryption.ts`) fetched this device's
 * envelope, unwrapped whatever AK it carried, and called `storeAK` — no
 * verification of any kind. The hybrid envelope is **anonymous**: `wrapAK` needs
 * only the target's PUBLIC ECDH + ML-KEM keys, which the server stores, so A2
 * mints an AK of its own and wraps it to the victim's own public keys. The
 * device unwraps it with its own private keys and cannot tell the sender
 * changed. Every write after that is sealed under a key A2 holds. Forward-only —
 * A2 cannot re-wrap the real DEKs, so pre-existing ciphertext stays sealed —
 * hence High rather than Critical.
 *
 * There *was* a check on one path, and understanding why it was not one is the
 * point of this file. `keyringUnwrapsUnderLocalAK` asks "does my stored AK still
 * open the keyring just served?", which on the `refreshAK` path runs AFTER the
 * AK was replaced, so it compares the served keyring against the key just taken
 * from the same attacker. And on the `stageKeyring` path, FAILING it is what
 * triggers the adoption — so the attacker picks the answer either way. It is a
 * currency probe that was mistaken for a possession check.
 *
 * The attack, using only A2's powers (rewrite two GET responses; read the
 * device's stored public keys):
 *   1. A2 mints a fresh AK' + DEK', wraps DEK' under AK', and wraps AK' to the
 *      device's stored ECDH+ML-KEM public keys (an anonymous envelope).
 *   2. A2 serves that envelope on `GET /devices/me/envelope` and a keyring on
 *      `GET /encryption/keys` whose primary DEK is wrapped under AK'.
 *   3. On the next boot the local-AK probe fails (the DEK is under AK', not the
 *      real AK), so pre-fix the client adopted AK' with no possession check.
 *   4. The next task encrypts under DEK' — which A2 holds — so A2 reads it.
 *
 * The fix is a device-local witness to DEK `"0"`'s key material: a fixed-plaintext
 * AES-GCM sample encrypted under DEK `"0"`, minted once from LOCAL state and
 * written to IndexedDB. A candidate AK is adopted only if it unwraps the SERVED
 * DEK `"0"` row into material that opens that sample. DEK `"0"` is minted once
 * per account and every legitimate AK rotation re-wraps the SAME key
 * (`rewrapKeyring`), so this passes for a real rotation and fails for a minted
 * AK — which is why the witness is a ciphertext UNDER the key rather than a copy
 * of its wrapping. A wrapping legitimately changes on every rotation; the key
 * underneath does not.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C
 * expected-failure while the vuln was open; once the witness check landed the
 * run reported "Expected to fail, but passed" and the `test.fail()` tag was
 * retired.
 *
 * Non-vacuity matters more here than usual, because `attackerCanDecrypt ===
 * false` would ALSO hold if the app had simply broken, or if the write had never
 * happened, or if the row had landed as plaintext. So this pins, in addition:
 * the refusal is actually logged by the guard (a console anchor — without it a
 * reverted fix could pass by accident); a row really was written and really is
 * v2 ciphertext; and the task still round-trips in the UI, proving the device
 * kept working keys rather than being wedged. The refusal path is supposed to
 * cost the user nothing.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/inbound-envelope-adoption.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  getDevicePublicKeys,
  getTaskIds,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  getDeviceId,
  loginViaConsumerOtp,
  serveEnvelope,
  serveWrappedKeys,
} from '../helpers'
import {
  decrypt,
  generateAK,
  generateDEK,
  importMlKemPublicKey,
  importPublicKey,
  wrapAK,
  wrapDEK,
} from '../../../src/crypto/primitives'
import { parseWireValue } from '../../../src/db/encryption/wire-format'
import { encodeAAD } from '../../../shared/e2ee-types'

test.describe.serial('THU-869 — inbound AK-envelope adoption', () => {
  test('a server-supplied AK envelope is refused when it cannot open DEK "0"', async ({ page }) => {
    const email = createE2eeEmail()
    const marker = `inbound-adoption-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    // A2 mints its own AK'/DEK' and the two responses it will serve. The AK' is
    // wrapped to the device's stored public keys, so the device unwraps it with
    // its own private keys and never notices the sender changed.
    const deviceId = await getDeviceId(page)
    const devicePublicKeys = await getDevicePublicKeys(deviceId)
    const attackerAk = await generateAK(true)
    const attackerDek = await generateDEK(true)
    const attackerEnvelope = await wrapAK(
      attackerAk,
      await importPublicKey(devicePublicKeys.ecdh),
      importMlKemPublicKey(devicePublicKeys.mlkem),
    )
    // Wrap the attacker DEK under the attacker AK for the served keyring. The
    // primary key_id is the one minted at first-device setup ("0"); the metadata
    // response is left untouched, so no key_version bump is needed — the failed
    // local-AK probe alone drives adoption.
    const primaryKeyId = '0'
    const attackerWrappedDek = await wrapDEK(attackerDek, attackerAk)

    // Collect the guard's refusal before navigating, so the boot that runs the
    // key responder's `prime` is observed.
    const consoleLines: string[] = []
    page.on('console', (message) => consoleLines.push(message.text()))

    await serveEnvelope(page.context(), attackerEnvelope)
    await serveWrappedKeys(page.context(), [{ key_id: primaryKeyId, wrapped_key: attackerWrappedDek }])

    // `createTask` navigates to /tasks, which re-inits the app and runs the key
    // responder's startup `prime` → `stageKeyring` against the malicious
    // responses. Adoption would happen at boot, long before the user-driven
    // write below. (Do NOT wait for `networkidle` — PowerSync holds a long-lived
    // sync stream, so the network is never idle and the wait times out.)
    const before = await getTaskIds(userId)
    await createTask(page, marker)
    const newRows = await waitForNewEncryptedTasks(userId, before)
    const row = newRows[0]
    expect(row).toBeTruthy()
    expect(row.item).toMatch(/^__enc:v2:/)
    expect(row.item).not.toContain(marker)

    // 1. The guard actually fired. Without this the SECURE assertion below could
    //    pass on a reverted fix for unrelated reasons.
    await expect
      .poll(() => consoleLines.some((line) => line.includes('refused an inbound account key')), { timeout: 30_000 })
      .toBe(true)

    // 2. SECURE assertion: the attacker's key must NOT open the write.
    const parsed = parseWireValue(row.item)
    expect(parsed).toBeTruthy()
    const attackerCanDecrypt = await decrypt(
      { iv: parsed!.iv, ciphertext: parsed!.ciphertext },
      attackerDek,
      encodeAAD('tasks', 'item', row.id, parsed!.keyId),
    )
      .then((plaintext) => plaintext.includes(marker))
      .catch(() => false)
    expect(attackerCanDecrypt).toBe(false)

    // 3. And a refusal costs the user nothing: the device kept the keys it
    //    already had, so the task it just wrote still reads back.
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
