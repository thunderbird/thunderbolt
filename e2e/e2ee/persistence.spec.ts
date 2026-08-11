/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getTaskIds,
  seedV1EncryptionMetadata,
  waitForAccountDeletion,
  waitForEncryptedSetting,
  waitForFirstDeviceState,
  waitForNewEncryptedTasks,
  waitForUserId,
} from './db'
import { expect, test } from './fixtures'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  readRecoveryPhrase,
  signOutKeepingData,
} from './helpers'

test.describe('PowerSync E2EE persistence and destructive flows', () => {
  test('survives reload and sync toggles, then clears keys and isolates data on sign-out', async ({ page }) => {
    const firstEmail = createE2eeEmail()
    const taskText = `Signed-out account task ${crypto.randomUUID()}`
    await loginViaConsumerOtp(page, firstEmail)
    const firstUserId = await waitForUserId(firstEmail)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(firstUserId, 'experimental_feature_tasks')
    const taskIdsBeforeCreate = await getTaskIds(firstUserId)
    await createTask(page, taskText)
    await waitForNewEncryptedTasks(firstUserId, taskIdsBeforeCreate)

    await page.reload()
    await expect(page.getByText(taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Save your recovery phrase', { exact: true })).toBeHidden()

    await page.goto('/settings/preferences')
    const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
    await syncSwitch.click()
    await expect(syncSwitch).not.toBeChecked()
    await syncSwitch.click()
    await expect(syncSwitch).toBeChecked()

    await signOutKeepingData(page)
    await expect.poll(() => getEncryptionKeyNames(page)).toEqual([])

    const secondEmail = createE2eeEmail()
    await loginViaConsumerOtp(page, secondEmail)
    await page.goto('/tasks')
    await expect(page.getByText(taskText, { exact: true })).toBeHidden()
  })

  test('deletes the account and cascades all E2EE server state', async ({ page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Delete My Account' }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation.getByText('Delete your account?')).toBeVisible()
    await confirmation.getByRole('button', { name: 'Delete account' }).click()

    await waitForAccountDeletion(userId)
    await expect(page.getByPlaceholder('Email')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => getEncryptionKeyNames(page)).toEqual([])
  })

  test('resets a safely seeded v1 account into fresh v2 setup', async ({ page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await seedV1EncryptionMetadata(userId)

    await page.goto('/settings/preferences')
    await page.getByRole('switch', { name: 'Sync This Device With Cloud' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await expect(dialog.getByText('Encryption was upgraded', { exact: true })).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Set up encryption again' }).click()
    await expect(dialog.getByText('First device setup', { exact: true })).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Continue' }).click()

    const recoveryPhrase = await readRecoveryPhrase(dialog)
    expect(recoveryPhrase.split(/\s+/)).toHaveLength(24)
    await dialog.getByRole('checkbox').click()
    await dialog.getByRole('button', { name: 'Done' }).click()

    expect(await waitForFirstDeviceState(userId)).toMatchObject({
      keyVersion: 1,
      primaryKeyId: '0',
      wrappedKeyIds: ['0'],
    })
  })
})
