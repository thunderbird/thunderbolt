/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh
 */

import {
  getEncryptionServerSnapshot,
  getTaskCiphertext,
  getTaskIds,
  waitForConsumedChallenge,
  waitForDeviceState,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from './db'
import { expect, test } from './fixtures'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createIsolatedDevice,
  createTask,
  enableTasks,
  finishAdditionalDeviceSetup,
  getDeviceId,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  readRecoveryPhrase,
  startAdditionalDeviceSetup,
  waitForTasksPreference,
} from './helpers'

test.describe('PowerSync E2EE key rotation', () => {
  test('changes the recovery phrase without rewriting existing ciphertext', async ({ browser, page }) => {
    const email = createE2eeEmail()
    const taskText = `Pre-rotation encrypted task ${crypto.randomUUID()}`
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    const oldRecoveryPhrase = await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)
    const [taskRow] = await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)
    expect(taskRow).toBeDefined()

    const before = await getEncryptionServerSnapshot(userId)
    const ciphertextBefore = await getTaskCiphertext(taskRow!.id)

    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Change Recovery Phrase' }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation.getByText('Change your recovery phrase?')).toBeVisible()
    await confirmation.getByRole('button', { name: 'Generate new phrase' }).click()

    const recoveryDialog = page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })
    const newRecoveryPhrase = await readRecoveryPhrase(recoveryDialog)
    expect(newRecoveryPhrase).not.toBe(oldRecoveryPhrase)
    const doneButton = recoveryDialog.getByRole('button', { name: 'Done' })
    await expect(doneButton).toBeDisabled()
    await recoveryDialog.getByRole('checkbox').click()
    await doneButton.click()

    await waitForConsumedChallenge(userId, 'rotate')
    await expect
      .poll(() => getEncryptionServerSnapshot(userId), { timeout: 30_000 })
      .toMatchObject({ keyVersion: before.keyVersion + 1, primaryKeyId: '0' })
    const after = await getEncryptionServerSnapshot(userId)
    expect(after.wrappedKeys['0']).not.toBe(before.wrappedKeys['0'])
    expect(after.envelopes).not.toEqual(before.envelopes)
    expect(await getTaskCiphertext(taskRow!.id)).toBe(ciphertextBefore)
    await page.goto('/tasks')
    await expect(page.getByText(taskText, { exact: true })).toBeVisible()

    const device = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(device.page, email)
      const setupDialog = await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await setupDialog.getByRole('button', { name: 'Use my recovery key' }).click()
      const recoveryInput = setupDialog.getByPlaceholder('word1 word2 word3 ...')

      await recoveryInput.fill(oldRecoveryPhrase)
      await setupDialog.getByRole('button', { name: 'Submit' }).click()
      await expect(
        setupDialog.getByText(
          'Invalid recovery phrase. Please check that all words are correct and in the right order.',
        ),
      ).toBeVisible({ timeout: 30_000 })

      await recoveryInput.fill(newRecoveryPhrase)
      await setupDialog.getByRole('button', { name: 'Submit' }).click()
      await waitForDeviceState(userId, deviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(device.page)
      await waitForTasksPreference(device.page)
      await device.page.goto('/tasks')
      await expect(device.page.getByText(taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await device.context.close()
    }
  })

  test('revokes a device, rotates AK and DEK, and uses the new key for future writes', async ({ browser, page }) => {
    const email = createE2eeEmail()
    const oldTaskText = `Before revoke ${crypto.randomUUID()}`
    const newTaskText = `After revoke ${crypto.randomUUID()}`
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const initialTaskIds = await getTaskIds(userId)
    await createTask(page, oldTaskText)
    await waitForNewEncryptedTasks(userId, initialTaskIds)

    const device = await createIsolatedDevice(browser, 'firefox')
    const remainingDevice = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(device.page, email)
      await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await waitForDeviceState(userId, deviceId, (state) => state.approvalPending)

      const notification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
      await expect(notification).toBeVisible({ timeout: 30_000 })
      await notification.getByRole('button', { name: 'Approve' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click()
      await waitForDeviceState(userId, deviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(device.page)
      await waitForTasksPreference(device.page)
      await device.page.goto('/tasks')
      await expect(device.page.getByText(oldTaskText, { exact: true })).toBeVisible({ timeout: 30_000 })

      await loginViaConsumerOtp(remainingDevice.page, email)
      await startAdditionalDeviceSetup(remainingDevice.page)
      const remainingDeviceId = await getDeviceId(remainingDevice.page)
      await waitForDeviceState(userId, remainingDeviceId, (state) => state.approvalPending)

      const remainingNotification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
      await expect(remainingNotification).toBeVisible({ timeout: 30_000 })
      await remainingNotification.getByRole('button', { name: 'Approve' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click()
      await waitForDeviceState(userId, remainingDeviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(remainingDevice.page)
      await waitForTasksPreference(remainingDevice.page)
      await remainingDevice.page.goto('/tasks')
      await expect(remainingDevice.page.getByText(oldTaskText, { exact: true })).toBeVisible({ timeout: 30_000 })

      const before = await getEncryptionServerSnapshot(userId)
      await page.goto('/settings/devices')
      await page.getByRole('button', { name: 'Revoke Firefox on macOS' }).click()
      const revokeDialog = page.getByRole('alertdialog')
      await expect(revokeDialog.getByText('Revoke this device?')).toBeVisible()
      await revokeDialog.getByRole('button', { name: 'Revoke' }).click()

      const recoveryDialog = page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })
      const newRecoveryPhrase = await readRecoveryPhrase(recoveryDialog)
      expect(newRecoveryPhrase.split(/\s+/)).toHaveLength(24)
      await recoveryDialog.getByRole('checkbox').click()
      await recoveryDialog.getByRole('button', { name: 'Done' }).click()

      await waitForConsumedChallenge(userId, 'revoke')
      await waitForDeviceState(
        userId,
        deviceId,
        (state) => !state.trusted && state.revokedAt !== null && !state.hasEnvelope,
      )
      await expect
        .poll(() => getEncryptionServerSnapshot(userId), { timeout: 30_000 })
        .toMatchObject({ keyVersion: before.keyVersion + 1, primaryKeyId: '1' })
      const after = await getEncryptionServerSnapshot(userId)
      expect(Object.keys(after.wrappedKeys).sort()).toEqual(['0', '1'])
      expect(after.wrappedKeys['0']).not.toBe(before.wrappedKeys['0'])
      expect(after.envelopes[deviceId]).toBeUndefined()

      const taskIdsBeforeCreate = await getTaskIds(userId)
      await createTask(page, newTaskText)
      const newRows = await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)
      for (const row of newRows) {
        expect(row.item).toMatch(/^__enc:v2:1:/)
      }
      await expect(page.getByText(oldTaskText, { exact: true })).toBeVisible()
      await expect(remainingDevice.page.getByText(newTaskText, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => getEncryptionKeyNames(remainingDevice.page))
        .toEqual(expect.arrayContaining(['thunderbolt_dek_1']))
      await expect(device.page.getByText('Device access revoked', { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await device.context.close()
      await remainingDevice.context.close()
    }
  })
})
