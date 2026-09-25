/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { defaultModelOpus5 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { loginViaEmailCode, openSidebarOnMobile, sendChatPrompt } from './helpers'
import { expect, test } from './test'

test.slow()
test.skip(process.env.E2E_EXTENDED_WEBKIT_PERSISTENT === 'true', 'PowerSync runs only in the Linux extended suite')

/** Enable cloud sync through the same preference a user sets on each device. */
const enableCloudSync = async (page: Page) => {
  await page.goto('/settings/preferences')
  const toggle = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await toggle.check()
  await expect(toggle).toBeChecked()
  await page.goto('/')
  await expect(page.locator('textarea')).toBeVisible()
}

test('a chat created on one device appears on another without reloading', async ({ page, browser, baseURL }) => {
  if (!baseURL) throw new Error('Extended sync project needs a baseURL')
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/v1/waitlist/join') {
      console.warn(`Consumer sign-in request failed: ${request.url()}: ${request.failure()?.errorText}`)
    }
  })
  await loginViaEmailCode(page)
  const storageState = await page.context().storageState()
  const otherDevice = await browser.newContext({
    baseURL,
    storageState: {
      ...storageState,
      origins: storageState.origins.map((origin) => ({
        ...origin,
        localStorage: origin.localStorage.filter(
          ({ name }) => name !== 'thunderbolt_device_id' && name !== 'thunderbolt_user_cache_secret',
        ),
      })),
    },
  })
  try {
    const secondPage = await otherDevice.newPage()
    await secondPage.goto('/')
    await expect(secondPage.locator('textarea')).toBeVisible()
    await enableCloudSync(page)
    await enableCloudSync(secondPage)
    expect(await page.evaluate(() => localStorage.getItem('thunderbolt_device_id'))).not.toBe(
      await secondPage.evaluate(() => localStorage.getItem('thunderbolt_device_id')),
    )

    await page.getByTestId('model-selector-trigger').click()
    await page.getByRole('button', { name: defaultModelOpus5.name, exact: true }).click()
    const title = `Sync check ${crypto.randomUUID().slice(0, 8)}`
    await sendChatPrompt(page, title)
    await expect(page.getByText(fakeProviderReply)).toBeVisible()

    await openSidebarOnMobile(secondPage)
    await expect(secondPage.getByText(title, { exact: true })).toBeVisible({ timeout: 60_000 })
  } finally {
    await otherDevice.close()
  }
})
