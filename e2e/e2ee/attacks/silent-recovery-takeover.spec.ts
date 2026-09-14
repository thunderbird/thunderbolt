/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-875 — silent recovery-slot takeover that survives revocation (C9/C5,
 * adversary A6 / a compromised trusted device, High). **Claim: a transient,
 * origin-level compromise of a trusted session must not be able to replace the
 * account's recovery phrase — silently or at all — without proof of inbox
 * access.**
 *
 * The original attack needed no lying server: a still-trusted attacker ran the
 * LEGITIMATE change-phrase flow (`changeRecoveryPhrase`) to re-anchor the
 * recovery slot to a phrase IT chose, with no signal on any other device. Every
 * later rotation — including the revoke that removed the attacker — faithfully
 * re-anchored the AK to the attacker's stored recovery keys, so the planted
 * phrase recovered the account forever while the victim's phrase silently died.
 *
 * FIXED (THU-875) by a server-enforced step-up gate + out-of-band notification:
 * `POST /encryption/rotate` refuses a body whose recovery public keys differ
 * from the stored ones unless it carries a fresh emailed code
 * (`step_up_required` / `step_up_invalid`), checked against the SESSION's email
 * and consumed on commit. The attacker holds the victim's session but not the
 * victim's inbox, so the plant is refused at the door; a committed re-anchor
 * additionally emails the account out-of-band. Same-key rotations (revocation's
 * silent re-anchor) are untouched — one-click revoke stays one-click.
 *
 * This spec witnesses the SECURE behavior directly (no `test.fail()` — the fix
 * is in): the attacker's change attempt dies at the gate with the recovery
 * anchor unmoved, the victim's revoke still works, and the victim's original
 * recovery keys remain the anchor throughout. The legitimate flow WITH inbox
 * access is the regression gate in `e2ee/rotation.spec.ts` (it completes the
 * step-up via `completeStepUpCode`), and the gate matrix (missing code, wrong
 * code, replay of a consumed code, keep-mode untouched) is unit-tested in
 * `backend/src/api/encryption-v2.test.ts`.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/silent-recovery-takeover.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  getEncryptionServerSnapshot,
  getTaskIds,
  waitForConsumedChallenge,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  trustAdditionalDevice,
} from '../helpers'

test.describe.serial('THU-875 — silent recovery-slot takeover', () => {
  test('a trusted attacker without inbox access cannot re-anchor the recovery slot', async ({ browser, page }) => {
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

    const original = await getEncryptionServerSnapshot(userId)

    // The attacker rides a trusted device (A6 in-origin script / borrowed
    // session) and drives the real Change Recovery Phrase flow — but it cannot
    // read the victim's email, so the best it can do at the code prompt is
    // guess. The harness models "no inbox access" by entering a wrong code
    // instead of reading the real one from the DB.
    const attackerDevice = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      const attackerPage = attackerDevice.page
      await attackerPage.goto('/settings/preferences')
      await attackerPage.getByRole('button', { name: 'Change Recovery Phrase' }).click()
      const confirm = attackerPage.getByRole('alertdialog')
      await confirm.getByRole('button', { name: 'Send code' }).click()

      const codeDialog = attackerPage.getByRole('alertdialog')
      await expect(codeDialog.getByText('Enter your verification code')).toBeVisible({ timeout: 15_000 })
      const rotateRefused = attackerPage.waitForResponse(
        (res) => res.url().includes('/v1/encryption/rotate') && res.request().method() === 'POST',
      )
      await codeDialog.locator('[data-slot="input-otp"]').fill('00000000')
      await codeDialog.getByRole('button', { name: 'Generate new phrase' }).click()

      // SECURE assertion 1: the rotate is refused at the step-up gate.
      expect((await rotateRefused).status()).toBe(403)
      await expect(codeDialog.getByText(/invalid or expired/i)).toBeVisible()

      // SECURE assertion 2: nothing moved server-side — the victim's recovery
      // keys are still the anchor and no rotation committed.
      const afterAttempt = await getEncryptionServerSnapshot(userId)
      expect(afterAttempt.recoveryEcdhPublicKey).toBe(original.recoveryEcdhPublicKey)
      expect(afterAttempt.recoveryMlkemPublicKey).toBe(original.recoveryMlkemPublicKey)
      expect(afterAttempt.keyVersion).toBe(original.keyVersion)
    } finally {
      await attackerDevice.context.close()
    }

    // The design's remedy still works, one-click: revoking the attacker device
    // is a same-key rotation and needs no step-up.
    await revokeTrustedDevice(page, attackerDevice.label)
    await waitForConsumedChallenge(userId, 'revoke')

    // SECURE assertion 3: post-revoke, the recovery anchor is STILL the
    // victim's keypair (re-wrapped to the new AK, same public keys) — there is
    // no attacker phrase in the account, so the takeover has nothing to
    // survive on. keyVersion advanced (the revoke rotation ran).
    const afterRevoke = await getEncryptionServerSnapshot(userId)
    expect(afterRevoke.recoveryEcdhPublicKey).toBe(original.recoveryEcdhPublicKey)
    expect(afterRevoke.recoveryMlkemPublicKey).toBe(original.recoveryMlkemPublicKey)
    expect(afterRevoke.keyVersion).toBeGreaterThan(original.keyVersion)
    expect(afterRevoke.recoveryWrappedAk).not.toBe(original.recoveryWrappedAk)
  })
})
