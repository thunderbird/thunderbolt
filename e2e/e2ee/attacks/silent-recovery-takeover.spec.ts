/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-875 — silent recovery-slot takeover that survives revocation (C9/C5,
 * adversary A4/A6, High). **Claim: revoking a device must not leave a recovery
 * phrase that device planted still able to recover the account.**
 *
 * Unlike THU-865, no lying server is needed. An attacker in a trusted position
 * (an A6 in-origin script, or an A4 device before it is revoked) runs the
 * LEGITIMATE change-phrase flow (`changeRecoveryPhrase`, src/services/encryption
 * .ts:872) to re-anchor the recovery slot to a phrase IT chose. The pending
 * marker is written only locally on the minting client (`markRecoveryPhrasePending`,
 * :849-851), so other devices show no signal — the takeover is silent. When the
 * user later revokes the device, the revoke rotation (`rotateAccountKey`, keep
 * mode) faithfully re-anchors the AK to the STORED recovery keys — which are the
 * attacker's (`readStoredRecoveryPlan` → `buildRecoverySlot`). The backend never
 * objects: `assertRecoveryCoverage` (backend/src/api/encryption.ts:194-200) is
 * presence-only and treats differing keys as a legal phrase change. So the
 * attacker's phrase still recovers the account AFTER the exact remedy the design
 * offers, and the user's genuine phrase is silently dead.
 *
 * The attack, using only a trusted device's own powers:
 *   1. A trusted attacker device runs Change Recovery Phrase → an attacker phrase.
 *   2. The user revokes that device (silent AK rotation re-anchors to the stored,
 *      i.e. attacker, recovery keys).
 *   3. On a fresh device the attacker recovers with its phrase and gets in.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — after the
 * revoke, the attacker's phrase must NOT recover the account — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now. When
 * THU-875 is fixed (distinguish keep vs change on the wire and reject differing
 * recovery keys on a keep-mode rotate; notify/audit any re-anchor), the attacker
 * recovery stops working, the assertion passes, and Playwright flags the
 * unexpected pass → drop the `test.fail()` tag for a permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/silent-recovery-takeover.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  getTaskIds,
  waitForConsumedChallenge,
  waitForDeviceState,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import {
  changeRecoveryPhraseViaUi,
  completeFirstDeviceSetup,
  createE2eeEmail,
  createIsolatedDevice,
  createTask,
  enableTasks,
  getDeviceId,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  startAdditionalDeviceSetup,
  trustAdditionalDevice,
} from '../helpers'

test.describe.serial('THU-875 — silent recovery-slot takeover', () => {
  test('a revoked device that changed the phrase can still recover the account', async ({ browser, page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const secret = `silent-takeover-${crypto.randomUUID()}`

    // Victim first device + an encrypted task only the account can read.
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const before = await getTaskIds(userId)
    await createTask(page, secret)
    await waitForNewEncryptedTasks(userId, before)

    // The attacker rides a trusted device and silently re-anchors the recovery
    // slot to a phrase it controls, via the real Change Recovery Phrase flow.
    const attackerDevice = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    const attackerPhrase = await changeRecoveryPhraseViaUi(attackerDevice.page)
    await waitForConsumedChallenge(userId, 'rotate')

    // The user revokes the attacker device — the design's remedy. Its silent AK
    // rotation re-anchors to the stored (attacker) recovery keys.
    await revokeTrustedDevice(page, attackerDevice.label)
    await waitForConsumedChallenge(userId, 'revoke')
    await attackerDevice.context.close()

    // The attacker recovers on a fresh device with the phrase it planted.
    const attacker = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(attacker.page, email)
      const dialog = await startAdditionalDeviceSetup(attacker.page)
      const attackerDeviceId = await getDeviceId(attacker.page)
      await dialog.getByRole('button', { name: 'Use my recovery key' }).click()
      await dialog.getByPlaceholder('word1 word2 word3 ...').fill(attackerPhrase)
      await dialog.getByRole('button', { name: 'Submit' }).click()

      // Did the revoked device's phrase still let the attacker in?
      const gotAccess = await waitForDeviceState(userId, attackerDeviceId, (s) => s.trusted && s.hasEnvelope)
        .then(() => true)
        .catch(() => false)

      // SECURE assertion: a revoked device's planted phrase must NOT recover the
      // account. Fails today (takeover survives the revoke); passes once fixed.
      expect(gotAccess).toBe(false)
    } finally {
      await attacker.context.close()
    }
  })
})
