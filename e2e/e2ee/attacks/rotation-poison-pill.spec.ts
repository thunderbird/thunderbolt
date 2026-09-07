/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-871 — rotation poison-pill: a junk `key_id` permanently blocks AK rotation
 * (C5/C14, adversary A2 / trusted device / A4, High). **Claim: an unopenable
 * keyring row must not be able to void cryptographic rotation/revocation.**
 *
 * `rewrapKeyring` (src/crypto/primitives.ts:185-203) re-wraps EVERY keyring row
 * under the new AK with a single `Promise.all` over `unwrapDEK` — so one row that
 * will not unwrap throws the whole rotation. A junk `wrapped_keys` row (planted
 * by a malicious server, or left by a trusted device via `POST /encryption/keys`,
 * whose wrapping the server cannot validate) therefore makes every future AK
 * rotation throw client-side (`runAKRotation`, src/services/encryption.ts:781-786).
 * Since revocation IS an AK rotation, cryptographic revocation dies: the row is
 * never GC'd, so the damage is permanent (DB surgery only).
 *
 * This spec plants one junk row, then triggers an AK rotation via the real
 * Change Recovery Phrase flow and checks the server's `key_version`: a successful
 * rotation bumps it, a poisoned one never does.
 *
 * Capability audit: planting a `wrapped_keys` row is A2's own DB power (or the
 * server-side residue of a trusted device's `POST /encryption/keys`); the
 * rotation is triggered by the legitimate user. Nothing the modeled adversary
 * lacks.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — an AK
 * rotation still completes (key_version advances) despite a junk row — and is
 * tagged `test.fail()` because the vuln is open today, so that assertion fails
 * now (rotation throws, key_version frozen). When THU-871 is fixed (make
 * `rewrapKeyring` non-fatal on a single unopenable row, and/or reject unknown
 * key_ids + cap keyring size), rotation completes, the assertion passes, and
 * Playwright flags the unexpected pass → drop the `test.fail()` tag for a
 * permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/rotation-poison-pill.spec.ts
 */

import { expect, test } from '../fixtures'
import { getEncryptionServerSnapshot, plantWrappedKey, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

test.describe.serial('THU-871 — rotation poison-pill', () => {
  test('a junk keyring row blocks AK rotation, freezing key_version', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const before = await getEncryptionServerSnapshot(userId)

    // A2 plants a junk keyring row: a fresh key_id whose wrapped_key is random
    // bytes that no AK can unwrap.
    const junk = Buffer.from(crypto.getRandomValues(new Uint8Array(40))).toString('base64')
    await plantWrappedKey(userId, `poison-${crypto.randomUUID()}`, junk)

    // Trigger an AK rotation via Change Recovery Phrase (its runAKRotation is the
    // same code revocation uses). On success key_version advances; a poisoned
    // rewrapKeyring throws before the rotation is posted.
    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Change Recovery Phrase' }).click()
    const confirm = page.getByRole('alertdialog')
    await confirm.getByRole('button', { name: 'Generate new phrase' }).click()

    // SECURE assertion: the rotation must still complete (key_version advances)
    // despite the junk row. Fails today (rewrapKeyring throws, key_version stays);
    // passes once THU-871 makes a single unopenable row non-fatal.
    await expect
      .poll(async () => (await getEncryptionServerSnapshot(userId)).keyVersion, { timeout: 30_000 })
      .toBeGreaterThan(before.keyVersion)
  })
})
