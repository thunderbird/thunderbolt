/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus55 } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
import { expect, test, type Page } from './test'

/** Load enough saved text to scroll without depending on a model response. */
const openLongConversation = async (page: Page) => {
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const text = Array.from(
    { length: 60 },
    (_, index) => `Paragraph ${index + 1}. Keep this conversation readable while scrolling through its history.`,
  ).join('\n\n')
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'scroll-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Scroll history' }],
      chat_messages: [
        {
          id: crypto.randomUUID(),
          chatThreadId: chatId,
          parentId: null,
          role: 'assistant',
          modelId: defaultModelOpus55.id,
          content: text,
          parts: [{ type: 'text', text }],
        },
      ],
    },
  })
  await page.goto(`/chats/${chatId}`)
  await expect(page.getByText('Paragraph 60.', { exact: false })).toBeAttached()
  const scroller = page.locator('.overflow-y-auto').filter({ has: page.locator('[data-message-id]') })
  await expect(scroller).toHaveCount(1)
  await scroller.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
  })
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible()
  return scroller
}

test.describe('mobile chat scrolling', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('a swipe starting on the down chevron scrolls without activating it, and a tap still jumps to the bottom', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Trusted touch drags require the Chromium input protocol')
    const errors = collectPageErrors(page)
    const scroller = await openLongConversation(page)
    const button = page.getByRole('button', { name: 'Scroll to bottom' })
    const before = await scroller.evaluate((element) => element.scrollTop)
    const bounds = (await button.boundingBox())!
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    const input = await page.context().newCDPSession(page)
    // A tap during momentum scrolling stops the fling instead of activating
    // the button. Wait for native scrolling to settle before testing a tap.
    const scrollEnded = scroller.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener('scrollend', () => resolve(), { once: true })
        }),
    )
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 12; step++) {
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 15 }] })
      await page.waitForTimeout(16)
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await input.detach()

    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 60)
    await scrollEnded
    await expect(button).toBeVisible()
    await expect.poll(async () => Math.abs((await button.boundingBox())!.y - bounds.y)).toBeLessThan(1)
    await button.tap()
    await expect(button).toBeHidden()
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThan(2)
    expect(errors).toEqual([])
  })
})

test('wheel scrolling over the down chevron moves the chat, and keyboard activation still jumps to the bottom', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(browserName === 'webkit' && isMobile, 'Playwright has no mouse wheel in mobile WebKit')
  const errors = collectPageErrors(page)
  const scroller = await openLongConversation(page)
  const button = page.getByRole('button', { name: 'Scroll to bottom' })
  const before = await scroller.evaluate((element) => element.scrollTop)
  await button.hover()
  await page.mouse.wheel(0, 180)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 60)
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(button).toBeHidden()
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThan(2)
  expect(errors).toEqual([])
})
