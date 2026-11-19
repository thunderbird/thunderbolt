/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { importBackup } from '../../e2e/import-backup'
import { expect, type Page } from '@playwright/test'
import { defaultModelOpus55 } from '../../shared/defaults/models'
import { fakeProviderReply } from '../../e2e/fake-provider'
import { loginViaEmailCode, openSidebarOnMobile } from '../../e2e/helpers'
import { modelOption } from './driver'

export type MeasureScenario = (name: string, action: () => Promise<void>, settleMs?: number) => Promise<void>

const fixtureEpoch = Date.UTC(2026, 10, 1)
const messageCount = 120
const sidebarChatCount = 40
export const longChatTitle = 'Performance conversation'
export const fixtureVersion = 2

/** Stable UUIDv7-shaped IDs preserve the app's chronological ordering and date labels. */
const fixtureId = (sequence: number) => {
  const timestamp = (fixtureEpoch + sequence).toString(16).padStart(12, '0')
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, '0')}`
}

const longChatId = fixtureId(10_000)

/** Wait for the sent bubble to be on screen and past the animation's fully transparent frame. */
const expectPaintedPrompt = async (page: Page, prompt: string) => {
  const bubble = page.locator('[data-message-id]').getByText(prompt, { exact: true })
  await expect(bubble).toBeInViewport()
  await expect
    .poll(
      () =>
        bubble.evaluate((element) => {
          let ancestor: Element | null = element
          while (ancestor) {
            if (Number(getComputedStyle(ancestor).opacity) === 0) {
              return false
            }
            ancestor = ancestor.parentElement
          }
          return true
        }),
      { intervals: [16, 16, 32] },
    )
    .toBe(true)
}

/** Populate real SQLite/FTS through the supported backup importer, without app-only test hooks. */
export const prepare = async (page: Page, options: { uniqueIds?: boolean } = {}) => {
  const email = await loginViaEmailCode(page)
  // Performance stacks are local-only; synced e2e projects need account-unique IDs while preserving chronology.
  const namespace = crypto.randomUUID().slice(-12)
  const id = (sequence: number) =>
    options.uniqueIds ? `${fixtureId(sequence).slice(0, -12)}${namespace}` : fixtureId(sequence)
  const seededChatId = id(10_000)
  const fixture = {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date(fixtureEpoch).toISOString(),
    user: { id: 'performance-fixture', email },
    tables: {
      chat_threads: [
        ...Array.from({ length: sidebarChatCount }, (_, index) => ({
          id: id(1_000 + index),
          title: `Performance sidebar chat ${index + 1}`,
        })),
        { id: seededChatId, title: longChatTitle },
      ],
      chat_messages: Array.from({ length: messageCount }, (_, index) => {
        const text =
          index % 2 === 0
            ? `Explain performance topic ${index + 1}: rendering, memory, and responsive interactions.`
            : `### Performance answer ${index + 1}\n\nKeep interactions responsive by doing only necessary work. ` +
              'A long conversation should remain easy to read and scroll.\n\n' +
              '- Measure the interaction before changing it.\n- Preserve keyboard and touch behavior.\n\n' +
              '```typescript\nconst total = values.reduce((sum, value) => sum + value, 0)\n```\n\n' +
              '| Operation | Result |\n| --- | --- |\n| Render | Complete |\n| Save | Complete |'
        return {
          id: id(20_000 + index),
          chatThreadId: seededChatId,
          parentId: index === 0 ? null : id(20_000 + index - 1),
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: text,
          parts: [
            ...(index === messageCount - 1
              ? [
                  {
                    type: 'reasoning',
                    text: 'Performance fixture reasoning: measure before optimizing.',
                    state: 'done',
                  },
                ]
              : []),
            { type: 'text', text },
          ],
          modelId: defaultModelOpus55.id,
          metadata: { modelId: defaultModelOpus55.id },
        }
      }),
      // The picker only displays its search field once there are more than ten models.
      models: Array.from({ length: 12 }, (_, index) => ({
        ...defaultModelOpus55,
        id: id(30_000 + index),
        name: `Performance model ${index + 1}`,
        isSystem: 0,
        defaultHash: null,
      })),
    },
  }
  await importBackup(page, fixture)
  await page.goto('/chats/new')
  await expect(page.locator('textarea')).toBeVisible()
  await page.getByTestId('model-selector-trigger').click()
  await modelOption(page, defaultModelOpus55.name).click()
  await page.keyboard.press('Escape')
  return { email, longChatId: seededChatId, messageCount, sidebarChatCount, additionalModels: 12 }
}

/** Exercise real UI flows; navigation inside measurement windows always stays in the SPA. */
export const runScenarios = async (page: Page, measure: MeasureScenario) => {
  const mobile = (page.viewportSize()?.width ?? 1280) < 768
  const composer = page.locator('textarea')
  const mobileDrawer = page.locator('[data-slot="sidebar"][data-mobile="true"][data-open]')
  await composer.fill('Please greet me briefly.')
  await measure(
    'first-send',
    async () => {
      await page.getByRole('button', { name: 'Send message' }).click()
      await expectPaintedPrompt(page, 'Please greet me briefly.')
      await expect(composer).toHaveValue('')
    },
    0,
  )
  await measure('first-reply-stream', async () => {
    await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
  })

  await openSidebarOnMobile(page)
  await measure('long-chat-open', async () => {
    await page.getByRole('button', { name: longChatTitle, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${longChatId}$`))
    await expect(page.getByRole('heading', { name: `Performance answer ${messageCount}`, exact: true })).toBeVisible()
  })
  await measure('long-chat-idle', async () => {}, 1_500)
  const scrollToBottom = page.getByRole('button', { name: 'Scroll to bottom', exact: true })
  await measure('long-chat-scroll', async () => {
    const viewport = page.viewportSize()!
    await page.mouse.move(viewport.width * 0.65, viewport.height * 0.4)
    await page.mouse.wheel(0, -900)
    await expect(scrollToBottom).toBeVisible()
  })
  await measure('long-chat-scroll-to-bottom', async () => {
    await scrollToBottom.click()
    await expect(scrollToBottom).toBeHidden()
    await expect(
      page.locator('[data-quotable-message-id]').last().getByRole('cell', { name: 'Save', exact: true }),
    ).toBeInViewport()
  })
  await measure('composer-typing', async () => {
    await composer.pressSequentially('Typing should remain instant with a long conversation.', { delay: 20 })
    await expect(composer).toHaveValue('Typing should remain instant with a long conversation.')
  })
  await composer.fill('')

  const modelSearch = page.getByPlaceholder('Search Models', { exact: true })
  await measure('model-menu-open', async () => {
    await page.getByTestId('model-selector-trigger').click()
    await expect(modelSearch).toBeVisible()
  })
  await measure('model-menu-search', async () => {
    await modelSearch.pressSequentially('Performance model 12', { delay: 20 })
    await expect(modelOption(page, 'Performance model 12')).toBeVisible()
    await expect(modelOption(page, 'Performance model 1')).toHaveCount(0)
  })
  await measure('model-menu-close', async () => {
    await page.keyboard.press('Escape')
    await expect(modelSearch).toBeHidden()
  })

  await measure('add-menu-open', async () => {
    await page.getByRole('button', { name: 'Add to chat', exact: true }).click()
    await expect(page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Upload file', exact: true })).toBeVisible()
  })
  await page.keyboard.press('Escape')
  await expect(page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Upload file', exact: true })).toBeHidden()

  const searchDialog = page.getByRole('dialog', { name: 'Search', exact: true })
  await measure('search-open', async () => {
    await page.keyboard.press('ControlOrMeta+k')
    await expect(searchDialog.getByRole('combobox')).toBeVisible()
  })
  await measure('search-query', async () => {
    await searchDialog.getByRole('combobox').pressSequentially(longChatTitle, { delay: 20 })
    await expect(searchDialog.getByRole('option').filter({ hasText: longChatTitle }).first()).toBeVisible()
  })
  await page.keyboard.press('Escape')
  await expect(searchDialog).toBeHidden()

  if (mobile) {
    await measure('mobile-sidebar-open', async () => {
      await openSidebarOnMobile(page)
      await expect(mobileDrawer).toBeVisible()
    })
    await measure('mobile-sidebar-close', async () => {
      await page.keyboard.press('Escape')
      await expect(mobileDrawer).toHaveCount(0)
    })
  } else {
    await measure('sidebar-collapse', async () => {
      await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
      await expect(page.locator('[data-side="left"][data-state="collapsed"]')).toBeVisible()
    })
    await measure('sidebar-expand', async () => {
      await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
      await expect(page.locator('[data-side="left"][data-state="expanded"]')).toBeVisible()
    })
    const chatRow = page.getByRole('button', { name: longChatTitle, exact: true })
    await measure('chat-menu-open', async () => {
      await chatRow.click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible()
    })
    const rename = page.getByRole('dialog', { name: 'Rename chat', exact: true })
    await measure('rename-dialog-open', async () => {
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      await expect(rename.getByRole('textbox', { name: 'Chat name' })).toBeFocused()
    })
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(rename).toBeHidden()
  }

  await composer.fill('Please greet me again briefly.')
  await measure(
    'long-chat-send',
    async () => {
      await page.getByRole('button', { name: 'Send message' }).click()
      await expectPaintedPrompt(page, 'Please greet me again briefly.')
      await expect(composer).toHaveValue('')
    },
    0,
  )
  await measure('long-chat-reply-stream', async () => {
    await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
  })

  // Route setup is outside measurement: opening the confirmation is the interaction under test.
  await page.goto('/settings/preferences')
  const accountButton = page.getByRole('button', { name: 'Delete My Account', exact: true })
  await accountButton.scrollIntoViewIfNeeded()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete your account?', exact: true })
  await measure('settings-dialog-open', async () => {
    await accountButton.click()
    await expect(confirmation).toBeVisible()
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  })
  await measure('settings-dialog-close', async () => {
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).toBeHidden()
  })
}
