/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-865 / A2b — recovery-slot substitution (C9, C2). **Claim: an AK rotation
 * that keeps the phrase must re-anchor the recovery slot only to the account's
 * real recovery keypair, never to one the server supplied.**
 *
 * C9 asserts "recovery-slot re-anchoring (which needs only the public half)
 * cannot be abused for takeover." It could. On every AK rotation that keeps the
 * phrase (e.g. a device revoke), the rotating device calls `readStoredRecoveryPlan`
 * (src/services/encryption.ts), which read `recovery_ecdh_public_key` /
 * `recovery_mlkem_public_key` straight from server metadata and wrapped the NEW AK
 * to them, with no verification. The backend `/encryption/rotate` accepted
 * whatever recovery keys the client submitted (`assertRecoveryCoverage` checked
 * presence only). So a malicious server that swapped the recovery public keys it
 * served during a silent re-anchor redirected the recovery slot to a keypair IT
 * chose — then recovered the account on a fresh device with a phrase it minted.
 *
 * The fix (THU-865) authenticates the anchor instead of trusting it. Every write
 * of the recovery slot now signs `userId ‖ kdf_salt ‖ recovery public keys` with
 * the epoch's canary-derived signing key, stored as `recovery_attestation`; a
 * phrase-preserving rotation verifies that signature against a signing key it
 * derives from its OWN keyring (unwrap DEK "0" → `verifyCanary`) before wrapping
 * anything. A2 cannot forge it — it does not hold DEK "0", so it cannot learn the
 * canary secret — and a missing or bad attestation fails closed.
 *
 * The attacker mints a phrase, derives its keypair under the account's real
 * `kdf_salt`, and injects the public halves during a revoke re-anchor. Two secure
 * assertions follow, root cause first:
 *   1. after the re-anchor, the stored recovery public key is still the account's
 *      own, and
 *   2. a fresh device submitting the attacker's phrase never becomes trusted.
 *
 * While the vuln is open the run short-circuits at (1) — the root cause — so the
 * takeover half executes only once the fix lands. That end-to-end takeover (the
 * attacker phrase recovering on a fresh device and rendering the victim's task)
 * was executed and recorded at commit `17e79451`, the pre-migration version of
 * this spec. It is not re-asserted here because a rejected recovery never reaches
 * the tasks view, so a "reads the secret" assertion could not flip green.
 *
 * Capability audit: A2 only — a lie on the wire for the recovery public keys
 * (`overrideEncryptionMetadata`) plus the account's `kdf_salt`, which the server
 * stores in cleartext. The attacker's phrase is minted fresh; the victim's real
 * phrase is never used and never needed.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C expected-failure
 * while the vuln was open; once the fix landed both assertions passed, Playwright
 * flagged the unexpected pass, and the `test.fail()` tag was retired — this is now
 * a permanent green regression gate. Verified to be a real gate, not a vacuous
 * one: with the attestation verification disabled in `readStoredRecoveryPlan` it
 * fails again on assertion 1.
 *
 * That residual is now CLOSED, and closing it rewrote the second half of this
 * spec. THU-887 pre-flights `readStoredRecoveryPlan` before the cut, so under
 * this attack the revoke aborts with nothing applied: the device stays trusted,
 * no `revoke` challenge is ever issued, and the dialog stays open carrying the
 * pre-cut "Nothing was changed" copy. What this spec no longer covers is the
 * verification on the ROTATION path — the one `changeRecoveryPhrase` takes —
 * since the attack is stopped before any rotation begins.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/recovery-slot-substitution.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  getEncryptionServerSnapshot,
  getKdfSalt,
  getTaskIds,
  waitForDeviceState,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createIsolatedDevice,
  createTask,
  enableTasks,
  getDeviceId,
  loginViaConsumerOtp,
  overrideEncryptionMetadata,
  startAdditionalDeviceSetup,
  trustAdditionalDevice,
} from '../helpers'
import {
  deriveRecoveryKeyPairFromSeed,
  encodeRecoverySeed,
  generateRecoverySeed,
} from '../../../src/crypto/recovery-key'
import { exportMlKemPublicKey, exportPublicKey } from '../../../src/crypto/primitives'

test.describe.serial('THU-865 — recovery-slot substitution', () => {
  test('a server lying about recovery keys during a re-anchor cannot take over the account', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()
    const secret = `recovery-takeover-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const before = await getTaskIds(userId)
    await createTask(page, secret)
    await waitForNewEncryptedTasks(userId, before)

    // The attacker mints a recovery phrase and derives its keypair under the
    // account's REAL kdf_salt — which a malicious server reads freely.
    const kdfSalt = await getKdfSalt(userId)
    const attackerSeed = generateRecoverySeed()
    const attackerPhrase = encodeRecoverySeed(attackerSeed)
    const attackerKeys = await deriveRecoveryKeyPairFromSeed(attackerSeed, kdfSalt)
    const attackerEcdhPublicKey = await exportPublicKey(attackerKeys.ecdhPublicKey)
    const attackerMlkemPublicKey = exportMlKemPublicKey(attackerKeys.mlkemPublicKey)

    const legit = await getEncryptionServerSnapshot(userId)
    expect(legit.recoveryEcdhPublicKey).not.toBe(attackerEcdhPublicKey)

    // Trust a victim device so revoking it triggers a silent re-anchor rotation.
    const victim = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })

    // The malicious server swaps the recovery public keys it serves to the admin;
    // the re-anchor wraps the NEW AK to the attacker's recovery keypair.
    await overrideEncryptionMetadata(page.context(), {
      recovery_ecdh_public_key: attackerEcdhPublicKey,
      recovery_mlkem_public_key: attackerMlkemPublicKey,
    })

    // Driven locally rather than through `revokeTrustedDevice`, whose closing
    // assertion is that the dialog CLOSES — true on every success path, and the
    // opposite of the point here. THU-887 pre-flights the anchor verification,
    // so this revoke aborts BEFORE the cut and the dialog stays open carrying
    // the pre-cut copy.
    await page.goto('/settings/devices')
    await page.getByRole('button', { name: `Revoke ${victim.label}` }).click()
    const revokeDialog = page.getByRole('alertdialog')
    await expect(revokeDialog.getByText('Revoke this device?')).toBeVisible()
    await revokeDialog.getByRole('button', { name: 'Revoke' }).click()

    // SECURE assertion 1: the tampered anchor is refused, and refused EARLY —
    // the wording is the pre-cut branch of `describeRevokeFailure`, so it is
    // also the proof that nothing was applied.
    await expect(revokeDialog.getByText(/Nothing was changed/i)).toBeVisible({ timeout: 30_000 })

    // Closed before the assertions below — leaving it open leaks the context on
    // every run.
    await victim.context.close()

    // SECURE assertion 2: nothing was applied. The victim is still trusted, so
    // the user has not been left with a device that looks revoked and is not
    // locked out (THU-887) — and no `revoke` challenge was ever issued, because
    // the nonce is fetched inside `revokeDeviceWithProof`, which never ran.
    const victimState = await waitForDeviceState(userId, victim.deviceId, (state) => state.trusted)
    expect(victimState.revokedAt).toBeNull()

    // SECURE assertion 3 (root cause): the recovery slot still holds the
    // account's OWN public key. Note this now passes because the attack is
    // stopped before any rotation runs, rather than by a rotation that refuses
    // the served anchor — the same function (`readStoredRecoveryPlan`) at an
    // earlier call site. The rotation-path verification, which
    // `changeRecoveryPhrase` takes, is no longer covered here.
    expect((await getEncryptionServerSnapshot(userId)).recoveryEcdhPublicKey).toBe(legit.recoveryEcdhPublicKey)

    // The takeover attempt: a fresh device submits the ATTACKER's phrase (no
    // intercept needed — if the re-anchor took, the server already holds the
    // attacker recovery slot).
    const attacker = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(attacker.page, email)
      const dialog = await startAdditionalDeviceSetup(attacker.page)
      const attackerDeviceId = await getDeviceId(attacker.page)
      await dialog.getByRole('button', { name: 'Use my recovery key' }).click()
      const input = dialog.getByPlaceholder('word1 word2 word3 ...')
      await input.fill(attackerPhrase)
      await dialog.getByRole('button', { name: 'Submit' }).click()

      // SECURE assertion 4: a phrase the account never minted must not unlock a
      // device, so the recovery is refused and the device stays untrusted with no
      // envelope. Before the fix it became trusted and read the victim's task —
      // that takeover was executed in full at commit `17e79451`.
      await expect(
        waitForDeviceState(userId, attackerDeviceId, (state) => state.trusted && state.hasEnvelope),
      ).rejects.toThrow()
    } finally {
      await attacker.context.close()
    }
  })
})
