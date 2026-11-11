/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Recovery after a server-forced wipe (C2/C9, adversary A2). **Claim: the
 * correct recovery phrase recovers only the account's own key lineage. A server
 * that wipes an established device cannot get the phrase to install a key set
 * the server minted.**
 *
 * The recovery envelope is anonymous: wrapping an Account Key needs only the
 * recovery PUBLIC keys, which the server stores. So A2 mints its own AK, DEK
 * "0", canary and signing key, wraps the AK to the real recovery public keys and
 * signs a matching recovery attestation. It then revokes the device. The client
 * gets `403 DEVICE_DISCONNECTED` and wipes its keys, including the local DEK "0"
 * witness that guards every other adoption. The
 * victim signs back in and types the correct phrase. The phrase opens the
 * forged envelope, and every check that compares one served artifact with
 * another passes. Before the fix the device became trusted and its next task
 * was sealed under a DEK "0" the attacker holds.
 *
 * The fix is the recovery continuity seal: DEK "0" sealed with a key derived
 * from the phrase, written whenever a phrase is minted. A2 holds neither DEK "0"
 * nor the phrase, so it cannot make a seal its own DEK "0" passes.
 *
 * Non-vacuity: a wrong phrase is refused first, the forged attempt is refused
 * with the continuity error rather than an unrelated failure, and once A2 stops
 * lying the same phrase on the same device recovers and writes a task the
 * attacker's DEK "0" cannot open.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/forced-wipe-recovery-substitution.spec.ts
 */

import { randomBytes } from 'node:crypto'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { expect, test } from '../fixtures'
import {
  getTaskIds,
  sql,
  waitForDeviceState,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  encryptionApiRequest,
  getDeviceId,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  startAdditionalDeviceSetup,
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
import { deriveSigningKeyPair, mintCanary, signRecoveryAttestation } from '../../../src/crypto/canary'
import { parseWireValue } from '../../../src/db/encryption/wire-format'
import { encodeAAD, initialKeyId } from '../../../shared/e2ee-types'

/** The server-held epoch A2 replaces: everything recovery reads except the phrase-bound seal. */
type RecoveryEpoch = {
  canaryIv: string
  canaryCtext: string
  signingPublicKey: string
  recoveryWrappedAk: string
  recoveryAttestation: string
  wrappedDek0: string
}

const readRecoveryEpoch = async (userId: string): Promise<RecoveryEpoch> => {
  const [row] = await sql<(RecoveryEpoch & { recoveryContinuity: string | null })[]>`
    SELECT m.canary_iv AS "canaryIv", m.canary_ctext AS "canaryCtext",
           m.signing_public_key AS "signingPublicKey", m.recovery_wrapped_ak AS "recoveryWrappedAk",
           m.recovery_attestation AS "recoveryAttestation", m.recovery_continuity AS "recoveryContinuity",
           k.wrapped_key AS "wrappedDek0"
    FROM encryption_metadata m
    JOIN wrapped_keys k ON k.user_id = m.user_id AND k.key_id = ${initialKeyId}
    WHERE m.user_id = ${userId}
  `
  if (!row?.recoveryContinuity) {
    throw new Error('Expected first-device setup to store a recovery continuity seal')
  }
  return row
}

const writeRecoveryEpoch = async (userId: string, epoch: RecoveryEpoch): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE encryption_metadata
      SET canary_iv = ${epoch.canaryIv}, canary_ctext = ${epoch.canaryCtext},
          signing_public_key = ${epoch.signingPublicKey}, recovery_wrapped_ak = ${epoch.recoveryWrappedAk},
          recovery_attestation = ${epoch.recoveryAttestation}
      WHERE user_id = ${userId}
    `
    await tx`
      UPDATE wrapped_keys SET wrapped_key = ${epoch.wrappedDek0}
      WHERE user_id = ${userId} AND key_id = ${initialKeyId}
    `
  })
}

/**
 * A2 mints a self-consistent epoch from server-side state alone: the account's
 * real recovery public keys and kdf_salt, which it stores in the clear.
 */
const forgeRecoveryEpoch = async (userId: string): Promise<{ epoch: RecoveryEpoch; attackerDek0: CryptoKey }> => {
  const [metadata] = await sql<
    { kdf_salt: string; recovery_ecdh_public_key: string; recovery_mlkem_public_key: string }[]
  >`
    SELECT kdf_salt, recovery_ecdh_public_key, recovery_mlkem_public_key
    FROM encryption_metadata WHERE user_id = ${userId}
  `
  const attackerAK = await generateAK(true)
  const attackerDek0 = await generateDEK(true)
  const { canaryIv, canaryCtext, canaryKey } = await mintCanary(attackerAK, userId)
  const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)
  return {
    attackerDek0,
    epoch: {
      canaryIv,
      canaryCtext,
      signingPublicKey: publicKeySpki,
      recoveryWrappedAk: await wrapAK(
        attackerAK,
        await importPublicKey(metadata!.recovery_ecdh_public_key),
        importMlKemPublicKey(metadata!.recovery_mlkem_public_key),
        initialKeyId,
        1,
      ),
      recoveryAttestation: await signRecoveryAttestation(canaryKey, {
        userId,
        kdfSalt: metadata!.kdf_salt,
        recoveryEcdhPublicKey: metadata!.recovery_ecdh_public_key,
        recoveryMlkemPublicKey: metadata!.recovery_mlkem_public_key,
      }),
      wrappedDek0: await wrapDEK(attackerDek0, attackerAK, initialKeyId),
    },
  }
}

test.describe.serial('Recovery after a server-forced wipe', () => {
  test('the correct phrase refuses a forged key set, then recovers the real one', async ({ page }) => {
    const email = createE2eeEmail()
    const marker = `forced-wipe-recovery-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    const phrase = await completeFirstDeviceSetup(page)
    const establishedDeviceId = await getDeviceId(page)
    const honest = await readRecoveryEpoch(userId)

    // A2 swaps in its own epoch, then revokes the device to force the wipe.
    const { epoch: forged, attackerDek0 } = await forgeRecoveryEpoch(userId)
    await writeRecoveryEpoch(userId, forged)
    await sql`UPDATE powersync.devices SET revoked_at = now() WHERE id = ${establishedDeviceId}`
    expect(await encryptionApiRequest(page, '/devices/me/envelope', { deviceId: establishedDeviceId })).toMatchObject({
      status: 403,
      body: { code: 'DEVICE_DISCONNECTED' },
    })
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await expect(page).toHaveURL(/\/device-revoked/, { timeout: 60_000 })
    expect(await getEncryptionKeyNames(page)).not.toContain('thunderbolt_ak')

    await page.getByRole('button', { name: 'Back to App' }).click()
    await loginViaConsumerOtp(page, email)
    const dialog = await startAdditionalDeviceSetup(page)
    const recoveringDeviceId = await getDeviceId(page)
    await dialog.getByRole('button', { name: 'Use my recovery key' }).click()
    const input = dialog.getByPlaceholder('word1 word2 word3 ...')
    const submit = dialog.getByRole('button', { name: 'Submit' })

    await input.fill(entropyToMnemonic(randomBytes(32), wordlist))
    await submit.click()
    await expect(
      dialog.getByText('Invalid recovery phrase. Please check that all words are correct and in the right order.'),
    ).toBeVisible()

    // The correct phrase opens the forged envelope, and the seal refuses it.
    await input.fill(phrase)
    await submit.click()
    await expect(dialog.getByText(/the account key the server supplied does not belong to it/)).toBeVisible({
      timeout: 60_000,
    })
    const refused = await waitForDeviceState(userId, recoveringDeviceId, () => true)
    expect(refused).toMatchObject({ trusted: false, hasEnvelope: false })
    expect(await getEncryptionKeyNames(page)).not.toContain('thunderbolt_ak')

    // A2 stops lying. Nothing was stored, so the same phrase now recovers.
    await writeRecoveryEpoch(userId, honest)
    await submit.click()
    await expect(dialog.getByText("You're all set!", { exact: true })).toBeVisible({ timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await waitForDeviceState(userId, recoveringDeviceId, (state) => state.trusted && state.hasEnvelope)

    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const before = await getTaskIds(userId)
    await createTask(page, marker)
    const [row] = await waitForNewEncryptedTasks(userId, before)
    const parsed = parseWireValue(row!.item)
    expect(parsed).not.toBeNull()
    await expect(
      decrypt(
        { iv: parsed!.iv, ciphertext: parsed!.ciphertext },
        attackerDek0,
        encodeAAD('tasks', 'item', row!.id, parsed!.keyId),
      ),
    ).rejects.toThrow()
  })
})
