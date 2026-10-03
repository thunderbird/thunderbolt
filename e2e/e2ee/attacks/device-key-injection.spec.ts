/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh
 *
 * A2 injects a device into the AK recipient set, and the next rotation hands it
 * the Account Key.
 *
 * The hole: `runAKRotation` builds its envelopes from `listTrustedDeviceKeys`,
 * a SERVER response, and `buildDeviceEnvelopes` (`src/services/encryption.ts`)
 * wraps the new AK to every public key in it with no verification of any kind.
 * Nothing on the client knows which devices the user actually approved, so a
 * row A2 writes into its own `devices` table is indistinguishable from a real
 * one. The server-side coverage check makes it worse rather than better: the
 * rotating client MUST supply an envelope for every id the server names
 * (`assertEnvelopeCoverage` / `listEnvelopeCapableDevices`), so A2 both picks
 * the recipients and enforces that the victim obeys.
 *
 * This is the same shape THU-865 closed for the RECOVERY slot, where the server
 * likewise stores the public keys the AK is wrapped to. There the fix was a
 * canary-signed attestation over those keys, verified by the rotating device
 * before it wraps anything (`readStoredRecoveryPlan`). Device public keys sit in
 * the identical position and carry no attestation.
 *
 * The rotation trigger here is a recovery-phrase change because it needs one
 * device; a revoke-driven rotation reaches `buildDeviceEnvelopes` by the same
 * path. Neither is required for the attack to land on a real account — the
 * v1→v2 migration also rotates, and it runs unattended at app start.
 *
 * Capability audit: A2 only, and only the half it has by definition — one INSERT
 * into its own `devices` table. No lie on the wire, no interception, no access
 * to the victim's phrase, keys or inbox. The victim performs an ordinary,
 * fully-authenticated action and the step-up code is entered by the real user.
 *
 * Polarity: asserts the SECURE behavior — the planted device recovers NOTHING.
 * Authored as an Option C expected-failure while the vuln is open. Today the
 * assertion fails with the victim's own task text as the received value, which
 * is the point: the chain is carried all the way to plaintext rather than
 * stopping at "an envelope exists", so the spec cannot be read as theoretical.
 * Retire the `test.fail()` tag when Playwright reports "Expected to fail, but
 * passed".
 */

import {
  getEncryptionServerSnapshot,
  getTaskCiphertext,
  getTaskIds,
  plantTrustedDevice,
  waitForConsumedChallenge,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import { expect, test } from '../fixtures'
import {
  completeFirstDeviceSetup,
  completeStepUpCode,
  createE2eeEmail,
  createTask,
  enableTasks,
  loginViaConsumerOtp,
  readRecoveryPhrase,
} from '../helpers'
import {
  decrypt,
  exportMlKemPublicKey,
  exportPublicKey,
  generateKeyPair,
  generateMlKemKeyPair,
  unwrapAK,
  unwrapDEK,
} from '../../../src/crypto/primitives'
import { parseWireValue } from '../../../src/db/encryption/wire-format'
import { encodeAAD } from '../../../shared/e2ee-types'

/** The planted device's own keypairs — the private halves never leave this process. */
type PlantedDevice = {
  id: string
  ecdhPrivateKey: CryptoKey
  mlkemSecretKey: Uint8Array
}

/**
 * Everything A2 does with the envelope it was handed: open it for the AK, use
 * the AK to open the primary DEK, and decrypt one real row.
 *
 * Returns the recovered plaintext, or null when the attack failed at any step —
 * including the step that SHOULD fail, which is no envelope being written for a
 * device the user never approved. Failures collapse to null rather than
 * throwing so the spec's single assertion reads as "recovered nothing".
 */
const attackerRecoverTaskText = async (
  planted: PlantedDevice,
  envelopes: Record<string, string>,
  wrappedKeys: Record<string, string>,
  taskId: string,
  taskCiphertext: string,
): Promise<string | null> => {
  const envelope = envelopes[planted.id]
  if (!envelope) {
    return null
  }
  try {
    const { ak } = await unwrapAK(envelope, planted.ecdhPrivateKey, planted.mlkemSecretKey)
    const parsed = parseWireValue(taskCiphertext)
    if (!parsed) {
      return null
    }
    const wrappedDek = wrappedKeys[parsed.keyId]
    if (!wrappedDek) {
      return null
    }
    const dek = await unwrapDEK(wrappedDek, ak, parsed.keyId)
    return await decrypt(
      { iv: parsed.iv, ciphertext: parsed.ciphertext },
      dek,
      encodeAAD('tasks', 'item', taskId, parsed.keyId),
    )
  } catch {
    return null
  }
}

test.describe('Unauthenticated device public keys (no ticket yet)', () => {
  test('a device A2 planted in the trusted list is handed the Account Key by the next rotation', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const taskText = `Victim task ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)
    const [taskRow] = await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)
    expect(taskRow).toBeDefined()
    const taskCiphertext = await getTaskCiphertext(taskRow!.id)

    // ── A2 ──────────────────────────────────────────────────────────────────
    // One INSERT. The keypairs are generated here and the private halves stay
    // here, so a wrap the victim performs to these public keys is openable by
    // this process and by nothing else.
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const planted: PlantedDevice = {
      // A bare UUID: exactly the 36 chars `envelopeEntrySchema.deviceId` allows.
      // A longer id is a different bug — the honest client dutifully builds an
      // envelope for it and the server then 422s the WHOLE rotation, so a row
      // A2 writes straight to the DB (bypassing `/devices`, which caps the id at
      // 36) blocks every future rotation and therefore every revocation.
      id: crypto.randomUUID(),
      ecdhPrivateKey: ecdh.privateKey,
      mlkemSecretKey: mlkem.secretKey,
    }
    await plantTrustedDevice(
      userId,
      planted.id,
      await exportPublicKey(ecdh.publicKey),
      exportMlKemPublicKey(mlkem.publicKey),
    )

    const before = await getEncryptionServerSnapshot(userId)
    expect(before.envelopes[planted.id]).toBeUndefined()

    // ── The victim performs an ordinary, authenticated rotation ─────────────
    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Change Recovery Phrase' }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation.getByText('Change your recovery phrase?')).toBeVisible()
    await confirmation.getByRole('button', { name: 'Send code' }).click()
    await completeStepUpCode(page, email)

    const recoveryDialog = page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })
    await readRecoveryPhrase(recoveryDialog)
    await recoveryDialog.getByRole('checkbox').click()
    await recoveryDialog.getByRole('button', { name: 'Done' }).click()

    await waitForConsumedChallenge(userId, 'rotate')
    await expect
      .poll(() => getEncryptionServerSnapshot(userId), { timeout: 30_000 })
      .toMatchObject({ keyVersion: before.keyVersion + 1 })
    const after = await getEncryptionServerSnapshot(userId)

    // ── What A2 walks away with ─────────────────────────────────────────────
    // SECURE: a device the user never approved recovers nothing, because no
    // envelope should have been written for it. The failure value today is the
    // victim's task text in full.
    const recovered = await attackerRecoverTaskText(
      planted,
      after.envelopes,
      after.wrappedKeys,
      taskRow!.id,
      taskCiphertext,
    )
    expect(recovered).toBeNull()
  })
})
