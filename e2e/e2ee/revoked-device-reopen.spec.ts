/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh
 */

import { waitForConsumedChallenge, waitForDeviceState, waitForUserId } from './db'
import { expect, test } from './fixtures'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  trustAdditionalDevice,
} from './helpers'

test.describe('revoked device reopened later', () => {
  test('a device revoked while its app was closed wipes itself the next time it starts online', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const device = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      // Non-vacuity: there is something to wipe.
      expect(await getEncryptionKeyNames(device.page)).toEqual(expect.arrayContaining(['thunderbolt_ak']))

      // Quit the app: offline first so the sync stream can't carry the revocation, then
      // close the page. The context keeps its storage, like an app on disk.
      await device.context.setOffline(true)
      await device.page.close()

      await revokeTrustedDevice(page, device.label)
      await waitForConsumedChallenge(userId, 'revoke')
      await waitForDeviceState(userId, device.deviceId, (state) => state.revokedAt !== null)

      // Its sessions died with the revocation, so only the session check's 403 can tell it.
      await device.context.setOffline(false)
      const reopened = await device.context.newPage()
      await reopened.goto('/')

      await expect(reopened.getByText('Device access revoked', { exact: true })).toBeVisible({ timeout: 30_000 })
      expect(await getEncryptionKeyNames(reopened)).toEqual([])
    } finally {
      await device.context.close()
    }
  })
})
