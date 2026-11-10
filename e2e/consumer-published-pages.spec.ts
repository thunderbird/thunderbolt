/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
import { defaultModelOpus55 } from '../shared/defaults/models'

/** Reopened tool results exercise the real transcript parser, verifier, frame and global page host. */
test('published file pages retain live state while website and device-local outputs use honest web fallbacks', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors = collectPageErrors(page)
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const htmlId = crypto.randomUUID()
  const websiteId = crypto.randomUUID()
  const localId = crypto.randomUUID()
  const failedPageId = crypto.randomUUID()
  const html = `<!doctype html><html><body>
<label>Unsaved draft <input aria-label="Unsaved draft"></label>
<button id="fail">Trigger runtime failure</button>
<script>document.getElementById('fail').onclick = () => { throw new Error('Late artifact runtime failure') }</script>
</body></html>`
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'published-pages-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Published page fixtures' }],
      chat_messages: [
        {
          id: crypto.randomUUID(),
          chatThreadId: chatId,
          parentId: null,
          role: 'assistant',
          content: '',
          modelId: defaultModelOpus55.id,
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'page_show_file',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: { path: 'failed.html' },
              output: {
                isError: true,
                ok: true,
                page: { id: failedPageId, title: 'Failed page must stay inert', source: { kind: 'html', html } },
              },
            },
            {
              type: 'dynamic-tool',
              toolName: 'page_show_file',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: { path: 'index.html' },
              output: {
                details: { ok: true, page: { id: htmlId, title: 'Published draft', source: { kind: 'html', html } } },
                content: [{ type: 'text', text: 'Published page' }],
              },
            },
            {
              type: 'tool-page_open',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: { url: 'https://example.com/' },
              output: {
                ok: true,
                page: {
                  id: websiteId,
                  title: 'External website',
                  source: { kind: 'url', url: 'https://example.com/' },
                },
              },
            },
            {
              type: 'tool-local_app',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: { action: 'create' },
              output: {
                status: 'ready',
                page: {
                  id: `local-app:${localId}`,
                  title: 'Device-only preview',
                  source: { kind: 'local-app', appId: localId },
                },
              },
            },
          ],
        },
      ],
    },
  })
  await page.goto(`/chats/${chatId}`)
  const frameElement = page.locator('[data-page-host] iframe[title="Published draft"]')
  await expect(frameElement).toBeVisible()
  const frame = frameElement.contentFrame()
  await frame.getByRole('textbox', { name: 'Unsaved draft' }).fill('Keep this draft through expansion')
  await frameElement.evaluate((element) => element.setAttribute('data-retained-frame', 'same-document'))
  await page.getByRole('button', { name: 'Open in side panel', exact: true }).first().click()
  await expect(page.locator('[data-page-panel]')).toBeVisible()
  await expect(frameElement).toHaveAttribute('data-retained-frame', 'same-document')
  await expect(frame.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('Keep this draft through expansion')
  await page.getByRole('button', { name: 'Show inline', exact: true }).click()
  await expect(frameElement).toHaveAttribute('data-retained-frame', 'same-document')
  await expect(frame.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('Keep this draft through expansion')

  const external = page.locator(`[data-published-page="${websiteId}"]`)
  await expect(external.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute(
    'href',
    'https://example.com/',
  )
  await expect(external.getByRole('link')).toHaveAttribute('target', '_blank')
  await expect(external.locator('[data-page-slot], iframe')).toHaveCount(0)
  await expect(page.getByText(/Its files do not sync/)).toBeVisible()
  await expect(page.locator('[data-page-host] iframe')).toHaveCount(1)
  await expect(page.locator(`[data-published-page="${failedPageId}"]`)).toHaveCount(0)
  await expect(page.locator('iframe[title="Failed page must stay inert"]')).toHaveCount(0)
  expect(errors).toEqual([])
  await frame.getByRole('button', { name: 'Trigger runtime failure' }).click()
  await expect(page.getByText(/Late artifact runtime failure/)).toBeVisible()
  await expect(frameElement).toBeVisible()
  await expect(frame.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('Keep this draft through expansion')
  expect(errors).toEqual(['Late artifact runtime failure'])
})
