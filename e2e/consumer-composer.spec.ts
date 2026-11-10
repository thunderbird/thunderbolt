/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelDeepSeekV41Flash, defaultModelOpus55 } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { fakeProviderReply } from './fake-provider'
import type { Locator } from '@playwright/test'
import { expect, test, type Page } from './test'

/** Check the painted controls, including their spacing, inside the actual composer. */
const expectControlsToFit = async (page: Page, controls: Locator[]) => {
  const form = page.locator('textarea').locator('xpath=ancestor::form')
  const bounds = await form.boundingBox()
  expect(bounds).not.toBeNull()
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()))
  for (const [index, box] of boxes.entries()) {
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
    if (index > 0) {
      const previous = boxes[index - 1]!
      expect(previous.x + previous.width).toBeLessThanOrEqual(box!.x)
    }
  }
  expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
}

for (const width of [1280, 390]) {
  test.describe(`composer menu dismissal at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 390 })

    test('switches menus with one click and dismisses them outside or with Escape', async ({ page }) => {
      await loginViaEmailCode(page)
      const location = page.getByRole('button', { name: 'Agent location', exact: true })
      const access = page.getByRole('button', { name: 'Agent access', exact: true })
      const press = async (target: Locator) => (width === 390 ? target.tap() : target.click())
      const openMenus = page.locator('[role="menu"][data-state="open"]')
      for (const [next, previous] of [
        [location, access],
        [access, location],
        [location, access],
      ]) {
        await test.step(`Open ${await next.getAttribute('aria-label')} and dismiss ${await previous.getAttribute('aria-label')}`, async () => {
          await press(next)
          await expect(next).toHaveAttribute('aria-expanded', 'true')
          await expect(previous).toHaveAttribute('aria-expanded', 'false')
          await expect(openMenus).toHaveCount(1)
        })
      }
      if (width === 390) {
        // The tall touch menu overlaps the composer; tap the empty margin first.
        await page.touchscreen.tap(width - 4, 80)
        await expect(openMenus).toHaveCount(0)
      }
      await press(page.locator('textarea'))
      await expect(openMenus).toHaveCount(0)
      await expect(page.locator('textarea')).toBeFocused()
      await press(access)
      await page.keyboard.press('Escape')
      await expect(openMenus).toHaveCount(0)
      await expect(access).toBeFocused()

      if (width === 1280) {
        const model = page.getByTestId('model-selector-trigger')
        const add = page.getByRole('button', { name: 'Add to chat', exact: true })
        await location.click()
        await model.click()
        await expect(location).toHaveAttribute('aria-expanded', 'false')
        await expect(model).toHaveAttribute('aria-expanded', 'true')
        await access.click()
        await expect(model).toHaveAttribute('aria-expanded', 'false')
        await expect(access).toHaveAttribute('aria-expanded', 'true')
        await add.click()
        await expect(access).toHaveAttribute('aria-expanded', 'false')
        await expect(add).toHaveAttribute('aria-expanded', 'true')
        await expect(openMenus).toHaveCount(1)
        await page.locator('textarea').click()
        await expect(openMenus).toHaveCount(0)
        await expect(page.locator('textarea')).toBeFocused()
      }
    })
  })
}

for (const { width, desktopSizing } of [
  { width: 320, desktopSizing: false },
  { width: 390, desktopSizing: false },
  { width: 500, desktopSizing: true },
  { width: 1280, desktopSizing: false },
]) {
  test.describe(`composer at ${width}px${desktopSizing ? ' with desktop sizing' : ''}`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('remembers model effort, accepts a screenshot drop, and keeps controls inside the composer', async ({
      page,
    }) => {
      const errors = collectPageErrors(page)
      await page.route('https://inference.tinfoil.sh/v1/models', (route) =>
        route.fulfill({
          json: {
            data: [
              { id: defaultModelDeepSeekV41Flash.model, reasoning: true, supported_efforts: ['low', 'medium', 'high'] },
            ],
          },
        }),
      )
      await loginViaEmailCode(page)

      const selector = page.getByTestId('model-selector-trigger')
      await expect(selector).toHaveAttribute('title', 'Reasoning effort: Low')
      await selector.click()
      const slider = page.getByRole('slider', { name: 'Reasoning effort' })
      await expect(slider).toHaveAttribute('aria-valuetext', 'Low')
      const sliderBounds = await slider.boundingBox()
      await slider.click({ position: { x: sliderBounds!.width - 2, y: sliderBounds!.height / 2 } })
      await expect(selector).toHaveAttribute('title', 'Reasoning effort: High')
      await expect(slider).toBeEnabled()
      await page.keyboard.press('Escape')

      await page.goto('/chats/new')
      await expect(selector).toHaveAttribute('title', 'Reasoning effort: High')
      await selector.click()
      await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
      await expect(selector).toHaveAttribute('title', 'Reasoning effort: Medium')
      await page.getByRole('button', { name: `${defaultModelDeepSeekV41Flash.name} Thunderbolt`, exact: true }).click()
      await expect(selector).toHaveAttribute('title', 'Reasoning effort: High')
      await page.keyboard.press('Escape')

      const textarea = page.locator('textarea')
      await textarea.fill('Describe this screenshot')
      for (const transferType of ['text/plain', 'text/uri-list']) {
        const textEventsAllowed = await page.locator('body, textarea').evaluateAll((elements, transferType) => {
          const dataTransfer = new DataTransfer()
          dataTransfer.setData(transferType, 'https://example.com/')
          return elements.map((element) =>
            ['dragover', 'drop'].map((type) =>
              element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })),
            ),
          )
        }, transferType)
        expect(textEventsAllowed).toEqual([
          [true, true],
          [true, true],
        ])
      }
      await expect(page.getByText('Drop file to attach', { exact: true })).toBeHidden()
      const dataTransfer = await page.evaluateHandle(() => {
        const transfer = new DataTransfer()
        const bytes = Uint8Array.from(
          atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0MsAAAAASUVORK5CYII='),
          (character) => character.charCodeAt(0),
        )
        transfer.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
        return transfer
      })
      const startingUrl = page.url()
      const outsideFileEventsAllowed = await page
        .locator('body')
        .evaluate(
          (element, dataTransfer) =>
            ['dragover', 'drop'].map((type) =>
              element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })),
            ),
          dataTransfer,
        )
      expect(outsideFileEventsAllowed).toEqual([false, false])
      await expect(page).toHaveURL(startingUrl)
      await expect(textarea).toHaveValue('Describe this screenshot')
      await expect(page.getByText('Drop file to attach', { exact: true })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Remove screenshot.png', exact: true })).toBeHidden()
      await textarea.dispatchEvent('dragover', { dataTransfer })
      await expect(page.getByText('Drop file to attach', { exact: true })).toBeVisible()
      await textarea.dispatchEvent('drop', { dataTransfer })
      await expect(page.getByRole('button', { name: 'Remove screenshot.png', exact: true })).toBeVisible()
      await expect(page.getByText('Drop file to attach', { exact: true })).toBeHidden()
      await dataTransfer.dispose()

      const context = page.getByRole('button', { name: 'Context usage', exact: true })
      const send = page.getByRole('button', { name: 'Send message', exact: true })
      const add = page.getByRole('button', { name: 'Add to chat', exact: true })
      await expect(send).toBeEnabled()
      await expectControlsToFit(page, [add, selector, send])

      // A real response supplies the context count. Public and confidential
      // models cannot be interchanged once a conversation has started.
      await selector.click()
      await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
      await page.keyboard.press('Escape')
      await send.click()
      await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible()
      await textarea.fill('Continue')
      if (desktopSizing) {
        // Only exercise native desktop CSS for geometry; opening a mobile JS
        // drawer under desktop CSS would create a state the native app never uses.
        await page.evaluate(() => document.documentElement.classList.add('force-desktop'))
      }
      await expect(context).toBeVisible()
      await expectControlsToFit(page, [add, context, selector, send])
      const contextBounds = (await context.boundingBox())!
      const addBounds = (await add.boundingBox())!
      expect(contextBounds.width).toBeGreaterThanOrEqual(contextBounds.height)
      expect(addBounds.width).toBe(addBounds.height)
      if (width < 768 && !desktopSizing) {
        expect(contextBounds.width).toBe(contextBounds.height)
      }
      const percentage = context.locator('span')
      const percentageBounds = await percentage.boundingBox()
      expect(percentageBounds).not.toBeNull()
      if (width < 768 && !desktopSizing) {
        expect(percentageBounds!.width).toBeLessThanOrEqual(1)
        await context.click()
        await expect(page.getByRole('dialog', { name: 'Context usage' }).getByText(/Context Window/)).toBeVisible()
        await page.keyboard.press('Escape')
      } else {
        expect(percentageBounds!.width).toBeGreaterThan(1)
      }

      // Supply connection snapshots directly: this regression concerns layout,
      // independently of the transport handshake covered by the ACP tests.
      for (const connectionStatus of ['connecting', 'error'] as const) {
        await page.evaluate(async (connectionStatus) => {
          const modulePath = '/src/chats/chat-store.ts'
          const { useChatStore } = (await import(/* @vite-ignore */ modulePath)) as typeof import('@/chats/chat-store')
          const store = useChatStore.getState()
          const id = store.currentSessionId!
          const session = store.sessions.get(id)!
          store.updateSession(id, {
            selectedAgent: {
              ...session.selectedAgent,
              name: 'An agent with a very long name that must never hide the send button',
            },
            connectionStatus,
            connectionError: connectionStatus === 'error' ? new Error('Connection failed') : null,
          })
        }, connectionStatus)
        const status = page
          .getByRole(connectionStatus === 'connecting' ? 'status' : 'alert')
          .filter({ hasText: /connect/i })
        await expect(status).toBeVisible()
        await expectControlsToFit(page, [add, status, context, send])
      }
      expect(errors).toEqual([])
    })
  })
}
