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
  // These local-app references use a generated UUID, never imported or browser-supplied text.
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
            {
              type: 'tool-local_app',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: { action: 'attach', title: 'Remote SSH service', port: 1420 },
              output: {
                status: 'ready',
                sessionId: 'previous-ssh-session',
                page: {
                  id: `local-app:${localId}`,
                  title: 'Remote SSH service',
                  source: { kind: 'local-app', appId: localId },
                },
              },
            },
            {
              type: 'tool-local_app',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: { action: 'update', appId: localId, args: ['server.cjs'] }, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
              output: {
                status: 'ready',
                updated: true,
                sessionId: 'old-preview-session',
                page: {
                  id: `local-app:${localId}`, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
                  title: 'Updated device-only preview',
                  source: { kind: 'local-app', appId: localId }, // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
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
  await expect(page.getByRole('button', { name: 'Show inline', exact: true })).toHaveCount(0)
  await page.evaluate(async (pageId) => {
    const modulePath = '/src/pages/page-store.ts'
    const { usePageStore } = (await import(modulePath)) as typeof import('../src/pages/page-store')
    const session = usePageStore.getState().sessions.find((item) => item.page.id === pageId)!
    usePageStore.getState().present(session.id, 'inline')
  }, htmlId)
  await expect(frameElement).toHaveAttribute('data-retained-frame', 'same-document')
  await expect(frame.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('Keep this draft through expansion')

  const pageTools = page.locator('.tool-invocation-card').filter({ hasText: 'Completed 4 steps' })
  await pageTools.getByRole('button', { name: /Completed 4 steps/ }).click()
  await expect(pageTools.getByTitle('This local app is unavailable on this device.')).toHaveCount(3)
  await expect(pageTools.getByTitle('This local app is unavailable on this device.').first()).toBeDisabled()
  await pageTools.getByTitle('External website', { exact: true }).click()
  const external = page.locator('[data-page-panel]')
  await expect(external.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute(
    'href',
    'https://example.com/',
  )
  await expect(external.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute('target', '_blank')
  await expect(external.locator('iframe')).toHaveCount(0)
  await expect(page.locator('[data-published-page]')).toHaveCount(0)
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

for (const toolName of ['render_html', 'page_show_file'] as const) {
  test(`${toolName} shows no sidebar publication widgets and keeps one latest preview only while inline`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const errors = collectPageErrors(page)
    const email = await loginViaEmailCode(page)
    const chatId = crypto.randomUUID()
    const pageId = crypto.randomUUID()
    const graphicId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const title = `${toolName} revision fixture`
    const publication = (html: string) => ({
      type: `tool-${toolName}`,
      toolCallId: crypto.randomUUID(),
      state: 'output-available',
      input: toolName === 'render_html' ? { title, html, presentation: 'sidebar' } : { path: 'app.html', title },
      output: {
        ok: true,
        presentation: 'sidebar',
        // Closing the live tab can make this false; transcript identity still determines revisions.
        updated: false,
        ...(toolName === 'render_html' ? { pageId } : { page: { id: pageId, title, source: { kind: 'html', html } } }),
      },
    })
    await importBackup(page, {
      format: 'thunderbolt-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      user: { id: 'publication-placement-fixture', email },
      tables: {
        chat_threads: [{ id: chatId, title: 'Publication placement fixture' }],
        chat_messages: [
          {
            id: messageId,
            chatThreadId: chatId,
            parentId: null,
            role: 'assistant',
            content: '',
            modelId: defaultModelOpus55.id,
            parts: [
              publication('<h1>Old app version</h1>'),
              publication('<h1>Latest app version</h1><label>Draft <input aria-label="Draft"></label>'),
              {
                type: 'tool-render_html',
                toolCallId: crypto.randomUUID(),
                state: 'output-available',
                input: {
                  title: 'Compact graphic',
                  html: '<svg width="80" height="40"><circle cx="20" cy="20" r="15" fill="purple"/></svg>',
                  presentation: 'inline',
                },
                output: { ok: true, pageId: graphicId, presentation: 'inline', updated: false },
              },
            ],
          },
        ],
      },
    })
    await page.goto(`/chats/${chatId}`)
    const appFrame = page.locator(`[data-page-host] iframe[title="${title}"]`)
    await expect(page.locator('[data-page-host] iframe[title="Compact graphic"]')).toBeVisible()
    await expect(appFrame).toHaveCount(0)
    await expect(page.locator('[data-page-panel]')).toHaveCount(0)
    const transcript = page.locator(`[data-message-id="${messageId}"]`)
    await expect(transcript.getByTitle('Open in side panel', { exact: true })).toHaveCount(1)
    await expect(transcript.getByText(title, { exact: true })).toHaveCount(0)
    await expect(transcript.locator('[data-published-page], [data-page-update]')).toHaveCount(0)
    await expect(transcript.getByRole('button', { name: 'Show inline', exact: true })).toHaveCount(0)
    const latestPage = {
      id: pageId,
      title,
      source: {
        kind: 'html' as const,
        html: '<h1>Latest app version</h1><label>Draft <input aria-label="Draft"></label>',
      },
    }
    const tools = transcript.locator('.tool-invocation-card')
    await tools.getByRole('button', { name: /Completed 2 steps/ }).click()
    // Both historical tool results reopen the latest snapshot, even the first creation.
    await tools.getByRole('button', { name: 'Open in side panel', exact: true }).first().click()
    await expect(page.locator('[data-page-panel]')).toBeVisible()
    await expect(appFrame.contentFrame().getByRole('heading', { name: 'Latest app version' })).toBeVisible()
    await appFrame.contentFrame().getByRole('textbox', { name: 'Draft' }).fill('Retain my draft')
    await page.evaluate(async (latestPage) => {
      const modulePath = '/src/pages/page-controller.ts'
      const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
      pageController.publishHtml(latestPage)
    }, latestPage)
    await expect(page.getByRole('tab', { name: title, exact: true })).toHaveCount(1)
    await expect(appFrame.contentFrame().getByRole('textbox', { name: 'Draft' })).toHaveValue('Retain my draft')
    await expect(transcript.getByText(title, { exact: true })).toHaveCount(0)
    await expect(transcript.locator('[data-published-page], [data-page-update]')).toHaveCount(0)
    const sessionId = await page.evaluate(async (pageId) => {
      const modulePath = '/src/pages/page-store.ts'
      const { usePageStore } = (await import(modulePath)) as typeof import('../src/pages/page-store')
      return usePageStore.getState().sessions.find((session) => session.page.id === pageId)!.id
    }, pageId)
    await page.evaluate(async (sessionId) => {
      const modulePath = '/src/pages/page-store.ts'
      const { usePageStore } = (await import(modulePath)) as typeof import('../src/pages/page-store')
      usePageStore.getState().present(sessionId, 'inline')
    }, sessionId)
    await expect(page.locator('[data-page-panel]')).toHaveCount(0)
    await expect(appFrame).toBeVisible()
    await expect(appFrame.contentFrame().getByRole('textbox', { name: 'Draft' })).toHaveValue('Retain my draft')
    await expect(transcript.getByTitle('Open in side panel', { exact: true })).toHaveCount(2)
    await expect(transcript.locator('[data-page-update]')).toHaveCount(0)
    await expect(page.locator('[data-page-host] iframe')).toHaveCount(2)
    // Closing/reloading does not reopen anything implicitly. The tool remains a recovery path.
    await page.evaluate(async (sessionId) => {
      const modulePath = '/src/pages/page-controller.ts'
      const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
      pageController.close(sessionId)
    }, sessionId)
    await expect(appFrame).toHaveCount(0)
    await page.reload()
    await expect(page.locator('[data-page-panel]')).toHaveCount(0)
    await expect(appFrame).toHaveCount(0)
    await tools.getByRole('button', { name: /Completed 2 steps/ }).click()
    await tools.getByRole('button', { name: 'Open in side panel', exact: true }).first().click()
    await expect(appFrame.contentFrame().getByRole('heading', { name: 'Latest app version' })).toBeVisible()
    await expect(appFrame.contentFrame().getByRole('heading', { name: 'Old app version' })).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
