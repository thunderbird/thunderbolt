/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v7 as uuidv7 } from 'uuid'
import { importBackup } from './import-backup'
import { expect, test } from './test'
import { collectPageErrors, loginViaEmailCode, openSidebarOnMobile } from './helpers'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { prepare } from '../scripts/performance/scenarios'
import { openLongChat } from '../scripts/performance/journeys'

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`quick-create navigation at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('leaving chat dismisses its model aside before Settings opens another', async ({ page }) => {
      const errors = collectPageErrors(page)
      await loginViaEmailCode(page)

      // Establish a forward-history destination for mobile, where the create
      // panel covers the sidebar but browser navigation remains available.
      await openSidebarOnMobile(page)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Models', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible()
      await page.goBack()
      await expect(page).toHaveURL(/\/chats\/new$/)

      await page.getByTestId('model-selector-trigger').click()
      await page.getByRole('button', { name: 'Add Model', exact: true }).click()
      const addModelHeading = page.getByRole('heading', { name: 'Add Model', exact: true })
      await expect(addModelHeading).toHaveCount(1)
      await expect(addModelHeading).toBeVisible()

      if (viewport.width < 768) {
        await page.goForward()
      } else {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'Models', exact: true }).click()
      }
      await expect(page).toHaveURL(/\/settings\/models$/)
      await expect(addModelHeading).toHaveCount(0)
      await page.getByRole('button', { name: 'New Model', exact: true }).click()
      await expect(addModelHeading).toHaveCount(1)
      await expect(addModelHeading).toBeVisible()

      await page.goBack()
      await expect(page).toHaveURL(/\/chats\/new$/)
      await expect(page.locator('textarea')).toBeEditable()
      await expect(addModelHeading).toHaveCount(0)
      expect(errors).toEqual([])
    })
  })
}

test('a saved compaction summary loads on first open and can be reopened', async ({ page }) => {
  const errors = collectPageErrors(page)
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const fixture = {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'compaction-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Saved compaction' }],
      chat_messages: [
        {
          id: crypto.randomUUID(),
          chatThreadId: chatId,
          parentId: null,
          role: 'assistant',
          content: 'The original answer is preserved.',
          parts: [{ type: 'text', text: 'The original answer is preserved.' }],
          modelId: defaultModelOpus55.id,
          metadata: {
            modelId: defaultModelOpus55.id,
            contextCompaction: {
              version: 1,
              summary:
                '## Saved decisions\n\nPreserve **keyboard shortcuts**.\n\n| Action | Result |\n| --- | --- |\n| Inspect | Read only |',
              tokensBefore: 8_000,
              contextTokens: 2_000,
              retainedTail: [{ role: 'user', content: 'Keep the unsent draft.', timestamp: 1 }],
            },
          },
        },
      ],
    },
  }
  await importBackup(page, fixture)
  await page.goto(`/chats/${chatId}`)
  const composer = page.locator('textarea')
  await composer.fill('Do not change this draft.')
  const summaryButton = page.getByRole('button', { name: 'Compacted View summary', exact: true })
  const summary = page.getByRole('region', { name: 'Compaction summary', exact: true })
  const summaryHost =
    (page.viewportSize()?.width ?? 1280) < 768 ? page.getByRole('dialog').filter({ has: summary }) : summary
  await summaryButton.click()
  await expect(summary.getByRole('heading', { name: 'Saved decisions', exact: true })).toBeVisible()
  await expect(summary.locator('strong')).toHaveText('keyboard shortcuts')
  await expect(summary.getByRole('cell', { name: 'Read only', exact: true })).toBeVisible()
  await summary.getByRole('button', { name: 'Retained messages and tool results' }).click()
  await expect(summary.getByText('Keep the unsent draft.', { exact: true })).toBeVisible()
  await summaryHost.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(summary).toBeHidden()
  await expect(composer).toHaveValue('Do not change this draft.')
  await summaryButton.click()
  await expect(summary.getByRole('heading', { name: 'Saved decisions', exact: true })).toBeVisible()
  await summaryHost.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(summary).toBeHidden()
  await expect(page.getByText('The original answer is preserved.', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('the reasoning panel restores mouse and keyboard resize widths after closing', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) < 768, 'Mobile uses a full-screen modal rather than a resizable panel')
  test.setTimeout(120_000)
  const errors = collectPageErrors(page)
  await prepare(page, { uniqueIds: true })
  await openLongChat(page)
  const answer = page.locator('[data-quotable-message-id]').last()
  await answer.getByRole('button', { name: /^Thought for / }).click()
  const thinking = answer.getByRole('button', { name: /^Thinking/ })
  await thinking.click()
  const panel = page.getByTestId('content-view')
  await expect(panel.getByRole('heading', { name: 'Reasoning', exact: true })).toBeVisible()
  await expect(panel).toContainText('Performance fixture reasoning: measure before optimizing.')
  // Width persistence must start after the opening animation has settled.
  await page.waitForTimeout(700)
  const initialWidth = (await panel.boundingBox())!.width
  const handle = page.locator('[data-slot="resizable-handle"]')
  const bounds = (await handle.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x - 100, bounds.y + bounds.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(initialWidth + 50)
  const draggedWidth = (await panel.boundingBox())!.width
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Reasoning', exact: true })).toBeHidden()
  await thinking.click()
  await expect.poll(async () => Math.abs((await panel.boundingBox())!.width - draggedWidth)).toBeLessThan(2)
  await page.waitForTimeout(400)
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(100)
  expect(errors).toEqual([])
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(draggedWidth + 1)
  const keyboardWidth = (await panel.boundingBox())!.width
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Reasoning', exact: true })).toBeHidden()
  await thinking.click()
  await expect.poll(async () => Math.abs((await panel.boundingBox())!.width - keyboardWidth)).toBeLessThan(2)
  expect(errors).toEqual([])
})

test('returning chat skips the closed onboarding passkey lookup while preferences still loads it', async ({ page }) => {
  const errors = collectPageErrors(page)
  const passkeyPath = '/v1/api/auth/passkey/list-user-passkeys'
  await page.route(/\/v1\/config$/, async (route) => {
    const response = await route.fetch()
    const config = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...config, passkeyEnabled: true } })
  })
  await page.route(`**${passkeyPath}`, (route) => route.fulfill({ json: [] }))
  await loginViaEmailCode(page)
  expect(await page.evaluate(() => typeof window.PublicKeyCredential === 'function')).toBe(true)
  const passkeyRequests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === passkeyPath) {
      passkeyRequests.push(request.url())
    }
  })
  await page.reload()
  const composer = page.locator('textarea')
  await expect(composer).toBeEditable()
  await composer.fill('The returning composer is ready.')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await page.waitForTimeout(1_000)
  expect(passkeyRequests).toEqual([])

  // A positive control ensures the deployment flag, browser capability, and endpoint match are effective.
  await page.goto('/settings/preferences')
  await expect.poll(() => passkeyRequests.length).toBeGreaterThan(0)
  await expect(page.getByText('Sign in with your fingerprint, face, or device PIN.', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('tool activity and adjacent text stay close in both directions without tightening separate turns', async ({
  page,
}) => {
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const assistantId = uuidv7()
  const userId = uuidv7()
  const answerId = uuidv7()
  const startedAt = Date.now()
  const tool = (path: string) => ({
    type: 'dynamic-tool',
    toolName: 'read',
    toolCallId: crypto.randomUUID(),
    state: 'output-available',
    input: { path },
    output: { content: [{ type: 'text', text: 'File contents' }] },
  })
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'activity-spacing-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Tool activity spacing' }],
      chat_messages: [
        {
          id: assistantId,
          createdAt: new Date(startedAt).toISOString(),
          chatThreadId: chatId,
          parentId: null,
          role: 'assistant',
          content: '',
          modelId: defaultModelOpus55.id,
          parts: [
            tool('index.html'),
            { type: 'text', text: 'Now writing the new game.' },
            tool('styles.css'),
            { type: 'text', text: 'The game is ready.' },
          ],
        },
        {
          id: userId,
          createdAt: new Date(startedAt + 1000).toISOString(),
          chatThreadId: chatId,
          parentId: assistantId,
          role: 'user',
          content: 'A separate user turn.',
          parts: [{ type: 'text', text: 'A separate user turn.' }],
        },
        {
          id: answerId,
          createdAt: new Date(startedAt + 2000).toISOString(),
          chatThreadId: chatId,
          parentId: userId,
          role: 'assistant',
          content: 'Independent answer.',
          modelId: defaultModelOpus55.id,
          parts: [{ type: 'text', text: 'Independent answer.' }],
        },
      ],
    },
  })
  await page.goto(`/chats/${chatId}`)
  const message = page.locator(`[data-message-id="${assistantId}"]`)
  const activity = message.locator('.tool-invocation-card')
  await expect(activity).toHaveCount(2)
  const text = message.getByText('Now writing the new game.', { exact: true })
  await expect(text).toBeVisible()
  // Read both rectangles together and wait for the message's entrance animation to settle.
  await expect
    .poll(() =>
      message.evaluate((element) => {
        const card = element.querySelector('.tool-invocation-card')!.getBoundingClientRect()
        const paragraph = [...element.querySelectorAll('.prose p')]
          .find((node) => node.textContent === 'Now writing the new game.')!
          .getBoundingClientRect()
        return Math.round(paragraph.top - card.bottom)
      }),
    )
    .toBe(8)
  await expect
    .poll(() =>
      message.evaluate((element) => {
        const card = element.querySelectorAll('.tool-invocation-card')[1].getBoundingClientRect()
        const paragraph = [...element.querySelectorAll('.prose p')]
          .find((node) => node.textContent === 'Now writing the new game.')!
          .getBoundingClientRect()
        return Math.round(card.top - paragraph.bottom)
      }),
    )
    .toBe(8)
  await expect(activity.nth(1).locator('..')).toHaveCSS('margin-top', '8px')
  const independentText = page.locator(`[data-message-id="${answerId}"] .prose`).locator('..')
  await expect(independentText).toHaveCSS('padding-top', '16px')
  await expect(independentText).toHaveCSS('margin-top', '8px')
  await expect(independentText).toHaveCSS('padding-bottom', '16px')
  await expect(independentText).toHaveCSS('margin-bottom', '8px')
})
