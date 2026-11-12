/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v7 as uuidv7 } from 'uuid'
import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'

for (const state of ['streaming', 'done'] as const) {
  test(`restored ${state} reasoning needs explicit recovery only when unfinished`, async ({ page }) => {
    const email = await loginViaEmailCode(page)
    const chatId = uuidv7()
    const promptId = uuidv7()
    const replyId = uuidv7()
    await importBackup(page, {
      format: 'thunderbolt-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      user: { id: 'interrupted-fixture', email },
      tables: {
        chat_threads: [{ id: chatId, title: 'Restored reasoning', isEncrypted: 0 }],
        chat_messages: [
          {
            id: promptId,
            chatThreadId: chatId,
            parentId: null,
            role: 'user',
            content: 'Please greet me briefly.',
            parts: [{ type: 'text', text: 'Please greet me briefly.' }],
          },
          {
            id: replyId,
            chatThreadId: chatId,
            parentId: promptId,
            role: 'assistant',
            content: '',
            modelId: defaultModelOpus55.id,
            metadata: { modelId: defaultModelOpus55.id },
            parts: [{ type: 'reasoning', text: 'Saved reasoning remains available after reloading.', state }],
          },
        ],
      },
    })
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/chat\/v1\/messages$/.test(new URL(request.url()).pathname)) {
        requests.push(request.url())
      }
    })
    await page.goto(`/chats/${chatId}`)
    await expect(page.locator(`[data-message-id="${replyId}"] .tool-invocation-card`)).toBeVisible()
    const warning = page.getByText(
      'This reply was interrupted before it finished. Retrying may repeat actions the agent already performed.',
      { exact: true },
    )
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
    if (state === 'done') {
      await expect(warning).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
      expect(requests).toHaveLength(0)
      return
    }
    await expect(warning).toBeVisible()
    expect(requests).toHaveLength(0)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(warning).toHaveCount(0)
    expect(requests).toHaveLength(1)
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible()
    await expect(warning).toHaveCount(0)
  })
}

test('restored terminal failure offers manual Retry after reloading', async ({ page }) => {
  const email = await loginViaEmailCode(page)
  const chatId = uuidv7()
  const promptId = uuidv7()
  const replyId = uuidv7()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'failed-turn-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Saved failed reply', isEncrypted: 0 }],
      chat_messages: [
        {
          id: promptId,
          chatThreadId: chatId,
          parentId: null,
          role: 'user',
          content: 'Please greet me briefly.',
          parts: [{ type: 'text', text: 'Please greet me briefly.' }],
        },
        {
          id: replyId,
          chatThreadId: chatId,
          parentId: promptId,
          role: 'assistant',
          content: '',
          modelId: defaultModelOpus55.id,
          metadata: { modelId: defaultModelOpus55.id, turnOutcome: 'error' },
          parts: [{ type: 'step-start' }],
        },
      ],
    },
  })
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/chat\/v1\/messages$/.test(new URL(request.url()).pathname)) {
      requests.push(request.url())
    }
  })
  await page.goto(`/chats/${chatId}`)
  const error = page.getByText('Something went wrong. Please try again.', { exact: true })
  await expect(error).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  expect(requests).toHaveLength(0)
  await page.reload()
  await expect(error).toBeVisible()
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  await expect(error).toHaveCount(0)
  expect(requests).toHaveLength(1)
})
