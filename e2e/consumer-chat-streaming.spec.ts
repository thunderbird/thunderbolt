/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'
import { defaultModelOpus5 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode } from './helpers'

/** Observe multiple rendered partial replies before the provider's complete answer. */
test('a sent message gets a reply that streams in', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)

  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus5.name, exact: true }).click()
  const composer = page.locator('textarea')
  await composer.fill('Please greet me briefly.')
  await page.evaluate(() => {
    const snapshots: string[] = []
    Object.assign(window, { assistantSnapshots: snapshots })
    const observer = new MutationObserver(() => {
      const text = document.querySelector('[data-quotable-message-id] .prose')?.textContent?.trim()
      if (text && snapshots.at(-1) !== text) snapshots.push(text)
    })
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
  })
  await composer.press('Enter')

  const reply = page.getByText(/^Hello(?:\s|$)/)
  await expect(reply).toHaveText(fakeProviderReply, { timeout: 30_000 })
  const snapshots = await page.evaluate(() => (window as Window & { assistantSnapshots: string[] }).assistantSnapshots)
  const completionIndex = snapshots.indexOf(fakeProviderReply)
  const partials = snapshots.slice(0, completionIndex).filter((text) => fakeProviderReply.startsWith(text))
  expect(new Set(partials).size).toBeGreaterThanOrEqual(2)
  expect(errors).toEqual([])
})
