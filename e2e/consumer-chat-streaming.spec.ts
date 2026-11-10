/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { performanceStreamEnd, performanceStreamPrompt, performanceStreamSections } from './streaming-fixture'
import { prepare } from '../scripts/performance/scenarios'
import { openLongChat } from '../scripts/performance/journeys'

type Snapshot = { text: string; at: number }

/** Observe partial replies before the response finishes downloading. */
test('a sent message gets a reply that streams in', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)

  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
  await page.keyboard.press('Escape')
  const composer = page.locator('textarea')
  await expect(page.getByRole('button', { name: 'Add a skill', exact: true })).toBeVisible()
  await composer.fill('Please greet me briefly.')
  await page.evaluate(() => {
    const snapshots: Snapshot[] = []
    Object.assign(window, { assistantSnapshots: snapshots })
    const observer = new MutationObserver(() => {
      const text = document.querySelector('[data-quotable-message-id] .prose')?.textContent?.trim()
      if (text && snapshots.at(-1)?.text !== text) {
        snapshots.push({ text, at: Date.now() })
      }
    })
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
  })
  const completion = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/chat\/v1\/messages$/.test(new URL(response.url()).pathname),
  )
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.locator('[data-message-id]').getByText('Please greet me briefly.', { exact: true }),
  ).toBeInViewport()
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Add a skill', exact: true })).toHaveCount(0)

  const reply = page.getByText(/^Hello(?:\s|$)/)
  await expect(reply).toHaveText(fakeProviderReply, { timeout: 30_000 })
  const response = await completion
  await response.finished()
  const { startTime, responseEnd } = response.request().timing()
  const finishedAt = startTime + responseEnd
  const snapshots = await page.evaluate(
    () => (window as Window & { assistantSnapshots?: Snapshot[] }).assistantSnapshots!,
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

  // Established chats retain caret-driven skill completion after the empty-chat skill bar unmounts.
  await composer.pressSequentially('/sea')
  const slash = page.getByRole('listbox', { name: 'Slash commands' })
  await expect(slash.getByRole('option', { name: /^Search/ })).toBeVisible()
  for (const key of Array.from({ length: 4 }, () => 'ArrowLeft')) {
    await composer.press(key)
  }
  await expect(slash).toBeHidden()
  for (const key of Array.from({ length: 4 }, () => 'ArrowRight')) {
    await composer.press(key)
  }
  await expect(slash.getByRole('option', { name: /^Search/ })).toBeVisible()
  await slash.getByRole('option', { name: /^Search/ }).click()
  await expect(slash).toBeHidden()
  await expect(composer).toHaveValue(/Search/)
  await expect(composer).toBeFocused()
  await composer.fill('A draft to keep while quoting.')
  await page.locator('[data-quotable-message-id] .prose').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove quote', exact: true })).toBeVisible()
  await expect(composer).toHaveValue('A draft to keep while quoting.')
  await page.getByRole('button', { name: 'Remove quote', exact: true }).click()
  await page.getByRole('button', { name: 'Context usage', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Compaction instructions (optional)' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto('/chats/new')
  await expect(page.getByRole('button', { name: 'Add a skill', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a high-rate markdown stream preserves a focused draft and persists the completed answer', async ({ page }) => {
  const errors = collectPageErrors(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
  await page.keyboard.press('Escape')
  const composer = page.locator('textarea')
  await composer.fill(performanceStreamPrompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('heading', { name: 'Streaming section 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeVisible()
  const draft = 'Keep this unsent draft while the answer streams.\nAnd keep its second line.'
  await composer.fill(draft)
  await composer.pressSequentially(' Still focused.', { delay: 20 })
  const reply = page.locator('[data-quotable-message-id]').last()
  await expect(reply).toContainText(performanceStreamEnd, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  await expect(composer).toHaveValue(`${draft} Still focused.`)
  await expect(composer).toBeFocused()
  await expect(reply.locator('h2')).toHaveCount(performanceStreamSections)
  await expect(reply.locator('pre')).toHaveCount(performanceStreamSections)
  await expect(reply.locator('table')).toHaveCount(performanceStreamSections)
  const completedText = await reply.innerText()
  await page.reload()
  await expect(page.locator('[data-quotable-message-id]').last()).toHaveText(completedText, { useInnerText: true })
  expect(errors).toEqual([])
})

test('sending into a long chat preserves its historical messages and the completed turn after reload', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors = collectPageErrors(page)
  const { messageCount } = await prepare(page, { uniqueIds: true })
  await openLongChat(page)
  const messages = page.locator('[data-message-id]')
  await expect(messages).toHaveCount(messageCount)
  const originalIds = await messages.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-message-id')),
  )
  const firstText = await messages.first().innerText()
  const lastHistoricalText = await messages.last().locator('.prose').innerText()
  const prompt = 'Please greet me briefly after this long conversation.'
  await page.locator('textarea').fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const reply = page.locator('[data-quotable-message-id]').last()
  await expect(reply).toContainText(fakeProviderReply, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  await expect(messages).toHaveCount(messageCount + 2)
  const completeIds = await messages.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-message-id')),
  )
  expect(completeIds.slice(0, messageCount)).toEqual(originalIds)

  await page.reload()

  await expect(messages).toHaveCount(messageCount + 2)
  expect(
    await messages.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-message-id'))),
  ).toEqual(completeIds)
  await expect(messages.first()).toHaveText(firstText, { useInnerText: true })
  await expect(messages.nth(messageCount - 1).locator('.prose')).toHaveText(lastHistoricalText, { useInnerText: true })
  await expect(messages.nth(messageCount)).toContainText(prompt)
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  expect(errors).toEqual([])
})
