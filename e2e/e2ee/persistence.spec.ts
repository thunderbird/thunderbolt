/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh
 *
 * NOTE: the reference suite's "resets a safely seeded v1 account into fresh v2
 * setup" test asserted the BETA reset model (wipe-on-upgrade). That model is
 * discarded — v1→v2 is now data-preserving, exercised end-to-end in
 * migration.spec.ts. It is intentionally NOT ported here.
 */

import {
  getTaskIds,
  waitForAccountDeletion,
  waitForEncryptedSetting,
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
})
