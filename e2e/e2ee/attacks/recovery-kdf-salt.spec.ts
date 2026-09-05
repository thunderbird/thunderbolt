/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C9 — recovery-phrase path under a lying server (C9, C2). **Claim holds.**
 *
 * The recovery keypair is derived from `seed + server-supplied kdf_salt`, so the
 * server controls one input to the derivation. C9 says a wrong `kdf_salt` must
 * fail cleanly, never downgrade or leak. `recoverWithKey`
 * (src/services/encryption.ts) derives the keypair, then checks the derived
 * public halves against the stored `recovery_*` keys BEFORE any unwrap or
 * network registration — a wrong salt yields a non-matching public key and a
 * clean `Invalid recovery key`. Even if a server also swapped the stored public
 * keys to match, the canary re-verification via DEK "0" is the backstop.
 *
 * This spec feeds the CORRECT 24-word phrase on a fresh device while the server
 * lies about `kdf_salt`, and asserts the recovery is rejected — the attacker
 * cannot turn a metadata lie into either access or a leak.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/recovery-kdf-salt.spec.ts
 */

import { expect, test } from '../fixtures'
import { getTaskIds, waitForEncryptedSetting, waitForNewEncryptedTasks, waitForUserId } from '../db'
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
} from '../helpers'
import { generateKdfSalt } from '../../../src/crypto/recovery-key'

const invalidPhraseError = 'Invalid recovery phrase. Please check that all words are correct and in the right order.'

test.describe.serial('C9 — recovery under a lying kdf_salt', () => {
  test('a wrong server-supplied kdf_salt makes recovery fail cleanly, not grant access', async ({ browser, page }) => {
    const email = createE2eeEmail()
    const taskText = `Recovery secret ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    const recoveryPhrase = await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const before = await getTaskIds(userId)
    await createTask(page, taskText)
    await waitForNewEncryptedTasks(userId, before)

    const device = await createIsolatedDevice(browser, 'firefox')
    try {
      // The malicious server lies about kdf_salt to this fresh device. The salt
      // is well-formed (correct length/base64), just not the account's real one.
      await overrideEncryptionMetadata(device.context, { kdf_salt: generateKdfSalt() })

      await loginViaConsumerOtp(device.page, email)
      const dialog = await startAdditionalDeviceSetup(device.page)
      await getDeviceId(device.page)
      await dialog.getByRole('button', { name: 'Use my recovery key' }).click()

      // The CORRECT phrase — the only thing wrong is the server's salt.
      const input = dialog.getByPlaceholder('word1 word2 word3 ...')
      await input.fill(recoveryPhrase)
      await dialog.getByRole('button', { name: 'Submit' }).click()

      // Clean rejection: derived public key != stored recovery public key.
      await expect(dialog.getByText(invalidPhraseError)).toBeVisible({ timeout: 30_000 })

      // No access granted — setup did not complete, the phrase entry is still
      // open, and the encrypted task never renders on this device.
      await expect(dialog.getByRole('button', { name: 'Submit' })).toBeVisible()
      await expect(device.page.getByText(taskText, { exact: true })).toHaveCount(0)
    } finally {
      await device.context.close()
    }
  })
})
