/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-869 — inbound AK-envelope adoption without a possession check (C8/C2/C1,
 * adversary A2, High). **Claim: an established v2 device must not adopt a
 * server-supplied AK it cannot tie back to a server-independent anchor.**
 *
 * On the keyring-staging path (`stageKeyring` → `adoptEnvelopeAK`,
 * src/services/encryption.ts:319-326,372-384), the client re-adopts its AK
 * whenever the locally stored AK fails to unwrap the keyring the server just
 * served (`keyringUnwrapsUnderLocalAK` returns false). It then fetches the
 * envelope, unwraps whatever AK it carries, and calls `storeAK` — with **no**
 * canary/possession verification, and **no** key_version bump required. The
 * hybrid envelope is anonymous (wrapped from the device's PUBLIC keys, which the
 * server stores), so a malicious server can mint a valid envelope for an AK it
 * chose. From then on every write encrypts under a server-known key. Forward-only
 * (A2 cannot re-wrap the real DEKs, so pre-existing ciphertext stays sealed),
 * hence High.
 *
 * The attack, using only A2's powers (rewrite two GET responses; read the
 * device's stored public keys):
 *   1. A2 mints a fresh AK' + DEK', wraps DEK' under AK', and wraps AK' to the
 *      device's stored ECDH+ML-KEM public keys (an anonymous envelope).
 *   2. A2 serves that envelope on `GET /devices/me/envelope` and a keyring on
 *      `GET /encryption/keys` whose primary DEK is wrapped under AK'.
 *   3. On the next boot the local-AK probe fails (the DEK is under AK', not the
 *      real AK), so the client adopts AK' with no possession check.
 *   4. The next task encrypts under DEK' — which A2 holds — so A2 reads it.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — the
 * attacker must NOT be able to decrypt the post-adoption write — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now. When
 * THU-869 is fixed (verify the served AK against a server-independent anchor —
 * pin `signing_public_key`, or require it to open a retained v2 ciphertext sample
 * — before `storeAK`), the assertion starts passing and Playwright flags the
 * unexpected pass → drop the `test.fail()` tag and it becomes a permanent
 * regression gate.
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
  test('a server-supplied AK envelope is adopted with no possession check', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

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
    await serveEnvelope(page.context(), attackerEnvelope)
    await serveWrappedKeys(page.context(), [{ key_id: primaryKeyId, wrapped_key: attackerWrappedDek }])

    // `createTask` navigates to /tasks, which re-inits the app and runs the key
    // responder's startup `prime` → `stageKeyring` against the malicious
    // responses. Adoption is a couple of localhost fetches at boot, long before
    // the user-driven write below, so the write encrypts under the adopted AK'.
    // (Do NOT wait for `networkidle` — PowerSync holds a long-lived sync stream,
    // so the network is never idle and the wait times out.)
    const before = await getTaskIds(userId)
    await createTask(page, marker)
    const newRows = await waitForNewEncryptedTasks(userId, before)
    const row = newRows[0]
    expect(row).toBeTruthy()
    expect(row.item).toMatch(/^__enc:v2:/)
    expect(row.item).not.toContain(marker)

    // The attacker holds AK'/DEK'. If the device adopted AK', the post-adoption
    // write is under DEK' and decrypts cleanly with the AAD the codec binds.
    const parsed = parseWireValue(row.item)
    expect(parsed).toBeTruthy()
    const attackerCanDecrypt = await decrypt(
      { iv: parsed!.iv, ciphertext: parsed!.ciphertext },
      attackerDek,
      encodeAAD('tasks', 'item', row.id, parsed!.keyId),
    )
      .then((plaintext) => plaintext.includes(marker))
      .catch(() => false)

    // SECURE assertion: the attacker's key must NOT open the write. Fails today
    // (adoption succeeds → attacker reads it); passes once THU-869 is fixed.
    expect(attackerCanDecrypt).toBe(false)
  })
})
