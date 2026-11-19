/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'
import { openSidebarOnMobile } from '../../e2e/helpers'
import { fakeProviderReply } from '../../e2e/fake-provider'
import { performanceStreamEnd, performanceStreamPrompt, performanceStreamSections } from '../../e2e/streaming-fixture'
import { longChatTitle, type MeasureScenario } from './scenarios'
import { clickAction, modelOption } from './driver'

export const defaultJourneyNames = ['open-chat', 'typing', 'overlays', 'stream'] as const
export const journeyNames = [...defaultJourneyNames, 'first-token'] as const
export type Journey = (typeof journeyNames)[number]

/** A scoped DOM predicate avoids Playwright's repeated accessibility-tree snapshots during a stream. */
const waitForText = async (
  page: Page,
  selector: string,
  text: string,
  painted = false,
  previousMessageId?: string | null,
) => {
  await page.waitForFunction(
    ({ selector, text, painted, previousMessageId }) => {
      const elements = document.querySelectorAll(selector)
      const element = elements[elements.length - 1]
      if (!element?.textContent?.includes(text)) {
        return false
      }
      if (
        previousMessageId &&
        element.closest('[data-quotable-message-id]')?.getAttribute('data-quotable-message-id') === previousMessageId
      ) {
        return false
      }
      if (!painted) {
        return true
      }
      const rect = element.getBoundingClientRect()
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.width === 0) {
        return false
      }
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (Number(getComputedStyle(ancestor).opacity) === 0) {
          return false
        }
      }
      return true
    },
    { selector, text, painted, previousMessageId },
    { polling: 50 },
  )
}

/** The same fixture and SPA navigation are used by each side of a pair. */
export const openLongChat = async (page: Page) => {
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: longChatTitle, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Performance answer 120', exact: true })).toBeVisible()
}

/** Focused journeys keep setup, aria queries, and correctness assertions outside timing windows. */
export const runJourney = async (page: Page, journey: Journey, measure: MeasureScenario, longStream: boolean) => {
  const composer = page.locator('textarea')
  if (journey === 'open-chat') {
    if (!page.url().endsWith('/chats/new')) {
      await page.goto('/chats/new')
    }
    await openSidebarOnMobile(page)
    const click = await clickAction(page, page.getByRole('button', { name: longChatTitle, exact: true }))
    await measure('long-chat-open', async () => {
      await click()
      await waitForText(page, '[data-quotable-message-id] h3', 'Performance answer 120')
    })
    await expect(page.getByRole('heading', { name: 'Performance answer 120', exact: true })).toBeVisible()
    return
  }
  if (!page.url().endsWith('/chats/new')) {
    await expect(composer).toBeVisible()
  } else {
    await openLongChat(page)
  }
  if (journey === 'typing') {
    const draft = 'Typing should remain instant with a long conversation.'
    await composer.fill('')
    await composer.focus()
    await measure('composer-typing', () => page.keyboard.type(draft, { delay: 20 }))
    await expect(composer).toHaveValue(draft)
    await expect(composer).toBeFocused()
    await composer.fill('')
    return
  }
  if (journey === 'overlays') {
    const search = page.locator('input[placeholder="Search Models"]')
    const click = await clickAction(page, page.getByTestId('model-selector-trigger'))
    await measure('model-menu-open', click, 500)
    await expect(search).toBeVisible()
    await search.focus()
    await measure('model-menu-search', () => page.keyboard.type('Performance model 12', { delay: 20 }))
    await expect(modelOption(page, 'Performance model 12')).toBeVisible()
    await expect(modelOption(page, 'Performance model 1')).toHaveCount(0)
    await measure('model-menu-close', () => page.keyboard.press('Escape'), 500)
    await expect(search).toBeHidden()
    if (page.viewportSize()!.width >= 768) {
      const answer = page.locator('[data-quotable-message-id]').last()
      await answer.getByRole('button', { name: /^Thought for / }).click()
      const openPanel = await clickAction(page, answer.getByRole('button', { name: /^Thinking/ }))
      await measure('reasoning-panel-open', openPanel, 500)
      const panel = page.locator('[data-slot="resizable-panel"]').last()
      await expect(panel.getByRole('heading', { name: 'Reasoning', exact: true })).toBeVisible()
      const closePanel = await clickAction(page, panel.getByRole('button', { name: 'Close', exact: true }))
      await measure('reasoning-panel-close', closePanel, 500)
      await expect(panel.getByRole('heading', { name: 'Reasoning', exact: true })).toBeHidden()
    }
    return
  }

  const prompt = longStream ? performanceStreamPrompt : 'Please greet me briefly.'
  const finalText = longStream ? performanceStreamEnd : fakeProviderReply
  await composer.fill(prompt)
  const previousMessageId = await page
    .locator('[data-quotable-message-id]')
    .last()
    .getAttribute('data-quotable-message-id')
  const click = await clickAction(page, page.locator('button[aria-label="Send message"]'))
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/chat\/v1\/messages$/.test(new URL(response.url()).pathname),
  )
  const finishReply = async () => {
    const response = await responsePromise
    if (!response.ok()) {
      throw new Error(`Provider response failed: ${response.status()}`)
    }
    await waitForText(page, '[data-quotable-message-id] .prose', finalText, false, previousMessageId)
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop generating"]'), undefined, {
      polling: 50,
    })
  }
  if (journey === 'first-token') {
    await measure(
      'long-chat-first-token',
      async () => {
        await click()
        await waitForText(page, '[data-quotable-message-id] .prose h2', 'Streaming section 1', true, previousMessageId)
      },
      0,
    )
    await finishReply()
  } else {
    await measure(
      'long-chat-send',
      async () => {
        await click()
        await waitForText(page, '[data-message-id]:not([data-quotable-message-id])', prompt, true)
      },
      0,
    )
    await measure('long-chat-reply-stream', finishReply, 100)
  }
  await expect(page.locator('[data-message-id]').getByText(prompt, { exact: true }).last()).toBeVisible()
  await expect(composer).toHaveValue('')
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(finalText)
  await expect(page.locator('button[aria-label="Stop generating"]')).toHaveCount(0)
  if (longStream) {
    const reply = page.locator('[data-quotable-message-id]').last()
    await expect(reply.locator('h2')).toHaveCount(performanceStreamSections)
    await expect(reply.locator('pre')).toHaveCount(performanceStreamSections)
    await expect(reply.locator('table')).toHaveCount(performanceStreamSections)
  }
}
