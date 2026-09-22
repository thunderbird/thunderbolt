/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'
import { defaultModelOpus5 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode } from './helpers'

type Snapshot = { text: string; at: number }

/** Observe partial replies before the response finishes downloading. */
test('a sent message gets a reply that streams in', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)

  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus5.name, exact: true }).click()
  const composer = page.locator('textarea')
  await composer.fill('Please greet me briefly.')
  await page.evaluate(() => {
    const snapshots: Snapshot[] = []
    Object.assign(window, { assistantSnapshots: snapshots })
    const observer = new MutationObserver(() => {
      const text = document.querySelector('[data-quotable-message-id] .prose')?.textContent?.trim()
      if (text && snapshots.at(-1)?.text !== text) snapshots.push({ text, at: Date.now() })
    })
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
  })
  const completion = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/chat\/completions$/.test(new URL(response.url()).pathname),
  )
  await composer.press('Enter')

  const reply = page.getByText(/^Hello(?:\s|$)/)
  await expect(reply).toHaveText(fakeProviderReply, { timeout: 30_000 })
  const response = await completion
  await response.finished()
  const { startTime, responseEnd } = response.request().timing()
  const finishedAt = startTime + responseEnd
  const snapshots = await page.evaluate(
    () => (window as Window & { assistantSnapshots: Snapshot[] }).assistantSnapshots,
  )
  const completionIndex = snapshots.findIndex(({ text }) => text === fakeProviderReply)
  expect(completionIndex, 'The observer must record the complete reply').toBeGreaterThanOrEqual(0)
  const partials = snapshots
    .slice(0, completionIndex)
    .filter(({ text }) => text.length > 0 && fakeProviderReply.startsWith(text))
  expect(
    partials[0] !== undefined && partials[0].at < finishedAt,
    `The first partial (${partials[0]?.at}) must render before the response finishes (${finishedAt})`,
  ).toBe(true)
  expect(new Set(partials.map(({ text }) => text)).size).toBeGreaterThanOrEqual(2)
  expect(errors).toEqual([])
})
