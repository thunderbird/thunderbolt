/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { completeFirstDeviceSetup, finishAdditionalDeviceSetup, startAdditionalDeviceSetup } from './e2ee/helpers'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, openSidebarOnMobile, sendChatPrompt } from './helpers'
import { expect, isolateProviderRequests, test } from './test'

test.slow()
test.skip(process.env.E2E_EXTENDED_WEBKIT_PERSISTENT === 'true', 'PowerSync runs only in the Linux extended suite')

/** Enrol a second device the way a user without the first device at hand does: with the recovery phrase. */
const enrollWithRecoveryPhrase = async (page: Page, recoveryPhrase: string) => {
  const dialog = await startAdditionalDeviceSetup(page)
  await dialog.getByRole('button', { name: 'Use my recovery key' }).click()
  await dialog.getByPlaceholder('word1 word2 word3 ...').fill(recoveryPhrase)
  await dialog.getByRole('button', { name: 'Submit' }).click()
  await finishAdditionalDeviceSetup(page)
}

test('a chat created on one device appears on another without reloading', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const errors = collectPageErrors(page)
  if (!baseURL) {
    throw new Error('Extended sync project needs a baseURL')
  }
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/v1/waitlist/join') {
      console.warn(`Consumer sign-in request failed: ${request.url()}: ${request.failure()?.errorText}`)
    }
  })
  const email = await loginViaEmailCode(page)
  const recoveryPhrase = await completeFirstDeviceSetup(page)
  // A session is bound to the device that set up encryption, so the second device needs its own sign-in.
  const otherDevice = await browser.newContext({ baseURL })
  try {
    await isolateProviderRequests(otherDevice, testInfo.project.name)
    const secondPage = await otherDevice.newPage()
    const secondErrors = collectPageErrors(secondPage)
    await loginViaEmailCode(secondPage, email)
    await enrollWithRecoveryPhrase(secondPage, recoveryPhrase)
    await page.goto('/')
    await secondPage.goto('/')

    await page.getByTestId('model-selector-trigger').click()
    await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
    const title = `Sync check ${crypto.randomUUID().slice(0, 8)}`
    await sendChatPrompt(page, title)
    await expect(page.getByText(fakeProviderReply)).toBeVisible()

    await openSidebarOnMobile(secondPage)
    await expect(secondPage.getByText(title, { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(errors).toEqual([])
    expect(secondErrors).toEqual([])
  } finally {
    await otherDevice.close()
  }
})
