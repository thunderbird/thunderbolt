/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-871 — rotation poison-pill: a junk `key_id` permanently blocks AK rotation
 * (C15/C5, adversary A2 / A6 on a trusted device, High). **Claim: an unopenable
 * keyring row must not be able to void cryptographic rotation/revocation.**
 *
 * `rewrapKeyring` (src/crypto/primitives.ts:185-202) re-wrapped EVERY keyring row
 * under the new AK with a single `Promise.all` over `unwrapDEK`, so one row that
 * would not unwrap threw the whole rotation. A junk `wrapped_keys` row — planted
 * by a malicious server, or left by a trusted device through the old
 * `POST /encryption/keys`, whose wrapping the server cannot validate because it
 * holds no AK — therefore made every future AK rotation throw client-side inside
 * `runAKRotation` (src/services/encryption.ts:900-980). Since revocation IS an AK
 * rotation, cryptographic revocation died: the removed device kept the old AK
 * forever. So did "Change Recovery Phrase", so a user who believed their phrase
 * was compromised could never change it.
 *
 * It was silent until then. `keyringUnwrapsUnderLocalAK` probes only the primary
 * key, so a non-primary junk row was a booby trap rather than a visible DoS.
 *
 * The fix makes the re-wrap non-fatal: a row that will not open is passed
 * through with its ORIGINAL blob and reported in `strandedKeyIds`, which the
 * caller logs. Pass-through, deliberately not deletion — the row keeps its
 * (key_id, DEK) slot, so a device that still holds the AK it was wrapped under
 * can repair it by re-wrapping and rotating again, whereas a delete would turn
 * recoverable damage into permanent loss on a claim the server structurally
 * cannot verify. A stranded DEK `"0"` is the one exception and is treated as a
 * STALE LOCAL AK (refresh + retryable `RotationStaleError`), because `"0"`
 * always exists and is always wrapped under the current AK.
 *
 * This spec plants one junk row, then triggers an AK rotation via the real
 * Change Recovery Phrase flow. That flow mints no DEK, and the planted id is
 * non-numeric so the allocator ignores it either way, which keeps this spec
 * isolated to the re-wrap defect — the mint-collision half has its own gate in
 * `attacks/dek-mint-collision.spec.ts`.
 *
 * Capability audit: planting a `wrapped_keys` row is A2's own DB power (or the
 * server-side residue of a trusted device's `POST /encryption/keys`, since
 * removed); the rotation is triggered by the legitimate user through the real UI.
 * Nothing the modeled adversary lacks.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C
 * expected-failure while the vuln was open; once the pass-through landed the run
 * reported "Expected to fail, but passed" and the `test.fail()` tag was retired.
 * Non-vacuity: "key_version advanced" alone would also hold if the rotation had
 * started skipping the keyring, so the spec additionally pins that a REAL row's
 * wrapping changed (the re-wrap genuinely happened) and that the junk row is
 * still present with its wrapping UNCHANGED (passed through, not deleted, and
 * not quietly re-wrapped into something meaningless).
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/rotation-poison-pill.spec.ts
 */

import { expect, test } from '../fixtures'
import { getEncryptionServerSnapshot, plantWrappedKey, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

test.describe.serial('THU-871 — rotation poison-pill', () => {
  test('a junk keyring row does not block AK rotation', async ({ page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const before = await getEncryptionServerSnapshot(userId)

    // A2 plants a junk keyring row: a fresh key_id whose wrapped_key is random
    // bytes that no AK can unwrap.
    const junk = Buffer.from(crypto.getRandomValues(new Uint8Array(40))).toString('base64')
    const junkKeyId = `poison-${crypto.randomUUID()}`
    await plantWrappedKey(userId, junkKeyId, junk)

    // Trigger an AK rotation via Change Recovery Phrase (its runAKRotation is the
    // same code revocation uses). On success key_version advances; a poisoned
    // rewrapKeyring threw before the rotation was ever posted.
    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Change Recovery Phrase' }).click()
    const confirm = page.getByRole('alertdialog')
    await confirm.getByRole('button', { name: 'Generate new phrase' }).click()

    // SECURE assertion: the rotation completes despite the junk row.
    await expect
      .poll(async () => (await getEncryptionServerSnapshot(userId)).keyVersion, { timeout: 30_000 })
      .toBeGreaterThan(before.keyVersion)

    const after = await getEncryptionServerSnapshot(userId)
    // The re-wrap really ran: a legitimate row moved to the new AK.
    expect(after.wrappedKeys['0']).not.toBe(before.wrappedKeys['0'])
    // And the junk row was passed through, not deleted and not rewritten — which
    // is what keeps it repairable rather than permanently destroyed.
    expect(after.wrappedKeys[junkKeyId]).toBe(junk)
  })
})
