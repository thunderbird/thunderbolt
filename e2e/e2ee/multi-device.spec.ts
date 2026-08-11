/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomBytes } from 'node:crypto'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
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
  startAdditionalDeviceSetup,
  waitForTasksPreference,
} from './helpers'

test.describe('PowerSync E2EE multi-device enrollment', () => {
  test('approves an isolated device and decrypts existing synced data', async ({ browser, page }) => {
    const email = createE2eeEmail()
    const taskText = `Existing encrypted task ${crypto.randomUUID()}`
    const returnTaskText = `Task from approved device ${crypto.randomUUID()}`
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)
    await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)

    const device = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(device.page, email)
      const waitingDialog = await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await waitForDeviceState(
        userId,
        deviceId,
        (state) => !state.trusted && state.approvalPending && !state.hasEnvelope,
      )

      const notification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
      await expect(notification).toBeVisible({ timeout: 30_000 })
      await notification.getByRole('button', { name: 'Approve' }).click()
      const confirmation = page.getByRole('alertdialog')
      await expect(confirmation.getByText('Approve this device?')).toBeVisible()
      await confirmation.getByRole('button', { name: 'Approve' }).click()

      await waitForConsumedChallenge(userId, 'approve')
      await waitForDeviceState(userId, deviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(device.page)
      await expect
        .poll(() => getEncryptionKeyNames(device.page))
        .toEqual(expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0']))

      await waitForTasksPreference(device.page)
      await device.page.goto('/tasks')
      await expect(device.page.getByText(taskText, { exact: true })).toBeVisible({ timeout: 30_000 })

      const taskIdsBeforeReturnCreate = await getTaskIds(userId)
      await createTask(device.page, returnTaskText)
      await waitForNewEncryptedTasks(userId, taskIdsBeforeReturnCreate)
      await expect(page.getByText(returnTaskText, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(waitingDialog).toBeHidden()
    } finally {
      await device.context.close()
    }
  })

  test('denies a pending device without issuing an envelope', async ({ browser, page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const device = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(device.page, email)
      await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await waitForDeviceState(userId, deviceId, (state) => state.approvalPending)

      const notification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
      await expect(notification).toBeVisible({ timeout: 30_000 })
      await notification.getByRole('button', { name: 'Deny' }).click()
      const confirmation = page.getByRole('alertdialog')
      await expect(confirmation.getByText('Deny this device?')).toBeVisible()
      await confirmation.getByRole('button', { name: 'Deny' }).click()

      await waitForConsumedChallenge(userId, 'deny')
      await waitForDeviceState(
        userId,
        deviceId,
        (state) => !state.trusted && !state.approvalPending && !state.hasEnvelope,
      )
      await expect(device.page.getByText('Request denied', { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await device.context.close()
    }
  })

  test('cancels a pending setup without trusting the device', async ({ browser, page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const device = await createIsolatedDevice(browser, 'windows')
    try {
      await loginViaConsumerOtp(device.page, email)
      const dialog = await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await waitForDeviceState(userId, deviceId, (state) => state.approvalPending)

      await dialog.getByRole('button', { name: 'Close' }).click()
      await expect(dialog).toBeHidden()
      await waitForDeviceState(
        userId,
        deviceId,
        (state) => !state.trusted && !state.approvalPending && !state.hasEnvelope,
      )
    } finally {
      await device.context.close()
    }
  })

  test('rejects invalid recovery phrases and enrolls with the valid phrase', async ({ browser, page }) => {
    const email = createE2eeEmail()
    const taskText = `Recovery encrypted task ${crypto.randomUUID()}`
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    const recoveryPhrase = await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')
    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)
    await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)

    const device = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(device.page, email)
      const dialog = await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await dialog.getByRole('button', { name: 'Use my recovery key' }).click()

      const input = dialog.getByPlaceholder('word1 word2 word3 ...')
      await input.fill('one two three')
      await expect(dialog.getByText('3/24 words', { exact: true })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled()

      const wrongPhrase = entropyToMnemonic(randomBytes(32), wordlist)
      await input.fill(wrongPhrase)
      await dialog.getByRole('button', { name: 'Submit' }).click()
      await expect(
        dialog.getByText('Invalid recovery phrase. Please check that all words are correct and in the right order.'),
      ).toBeVisible({ timeout: 30_000 })

      await input.fill(recoveryPhrase)
      await dialog.getByRole('button', { name: 'Submit' }).click()
      await waitForConsumedChallenge(userId, 'approve')
      await waitForDeviceState(userId, deviceId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(device.page)
      await waitForTasksPreference(device.page)
      await device.page.goto('/tasks')
      await expect(device.page.getByText(taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await device.context.close()
    }
  })
})
