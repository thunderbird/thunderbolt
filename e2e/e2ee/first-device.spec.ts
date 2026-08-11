/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './fixtures'
import {
  getTaskIds,
  waitForEncryptedSetting,
  waitForFirstDeviceState,
  waitForNewEncryptedTasks,
  waitForUserId,
} from './db'
import {
  completeFirstDeviceSetup,
  createTask,
  createE2eeEmail,
  enableTasks,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
} from './helpers'

test.describe.serial('PowerSync E2EE first device', () => {
  test('stores a browser-created task as ciphertext in PostgreSQL', async ({ page }) => {
    const email = createE2eeEmail()
    const taskText = `Playwright encrypted task ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const serverState = await waitForFirstDeviceState(userId)
    expect(serverState).toEqual({
      keyVersion: 1,
      primaryKeyId: '0',
      wrappedKeyIds: ['0'],
      trustedDeviceCount: 1,
      envelopeCount: 1,
    })

    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    await expect
      .poll(() => getEncryptionKeyNames(page))
      .toEqual(
        expect.arrayContaining([
          'thunderbolt_ak',
          'thunderbolt_dek_0',
          'thunderbolt_key_version',
          'thunderbolt_mlkem_public_key',
          'thunderbolt_mlkem_secret_key',
          'thunderbolt_primary_key_id',
          'thunderbolt_private_key',
          'thunderbolt_public_key',
        ]),
      )

    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)

    const newServerRows = await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)
    expect(newServerRows.length).toBeGreaterThan(0)
    for (const row of newServerRows) {
      expect(row.item).toMatch(/^__enc:v2:0:/)
      expect(row.item).not.toContain(taskText)
    }

    await page.goto('/settings/preferences')
    const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
    await syncSwitch.click()
    await expect(syncSwitch).not.toBeChecked()
  })
})
