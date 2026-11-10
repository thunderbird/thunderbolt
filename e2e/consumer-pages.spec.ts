/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { loginViaEmailCode, collectPageErrors } from './helpers'
import { importBackup } from './import-backup'
import { defaultModelOpus55 } from '../shared/defaults/models'

const html = `<!doctype html><html><head><title>Stateful counter</title></head><body>
<label>Keep my text <input id="entry" aria-label="Keep my text"></label>
<button id="increment">Increment</button><output id="count">0</output>
<script>let count = 0; document.getElementById('increment').onclick = () => document.getElementById('count').textContent = String(++count);</script>
</body></html>`

test('the web header opens the browser and its desktop download prompt without pretending to navigate', async ({
  page,
}) => {
  await loginViaEmailCode(page)
  const opener = page.getByRole('button', { name: 'Open browser', exact: true })
  await expect(opener).toBeVisible()
  await opener.click()
  const panel = page.locator('[data-page-panel]')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Browse with your agent' })).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Download desktop app' })).toHaveAttribute(
    'href',
    'https://github.com/thunderbird/thunderbolt/releases/latest',
  )
  await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveCount(0)
  const address = panel.getByRole('button', { name: 'Browse in the desktop app' })
  await expect(address).toContainText('Desktop app')
  await address.click()
  const prompt = page.getByRole('dialog', { name: 'Browse in the desktop app' })
  await expect(prompt.getByRole('link', { name: 'Download desktop app' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(prompt).toBeHidden()
  await address.click()
  await page.locator('textarea').click()
  await expect(prompt).toBeHidden()
  await expect(page.locator('textarea')).toBeFocused()
  await panel.getByRole('button', { name: 'New tab', exact: true }).click()
  await panel.getByRole('button', { name: 'New tab', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(3)
  await panel.locator('[data-browser-tab-empty]').dblclick()
  await expect(panel.getByRole('tab')).toHaveCount(4)
  await page.locator('[data-browser-toggle]').click()
  await expect(panel).toHaveCount(0)
  await expect(opener).toHaveAttribute('aria-pressed', 'false')
  await opener.click()
  await expect(panel.getByRole('tab')).toHaveCount(4)
})

test('the same artifact keeps DOM state through inline, sidebar and expanded presentations and pins as an app', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors = collectPageErrors(page)
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const toolCallId = crypto.randomUUID()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'page-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Stateful page fixture' }],
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
              type: 'tool-render_html',
              toolCallId,
              state: 'output-available',
              input: { title: 'Stateful counter', html },
              output: { ok: true },
            },
          ],
        },
      ],
    },
  })
  await page.goto(`/chats/${chatId}`)
  const iframe = page.locator('[data-page-host] iframe[title="Stateful counter"]')
  await expect(iframe).toBeVisible()
  const frame = iframe.contentFrame()
  await frame.getByRole('textbox', { name: 'Keep my text' }).fill('Preserve this unsaved text')
  await frame.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(frame.locator('#count')).toHaveText('1')
  // Use the actual adapter/controller path (with the page's sandbox protocol), without a model mock.
  const observation = await page.evaluate(async () => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    const session = pageController.list().find((item) => item.title === 'Stateful counter')!
    const snapshot = await pageController.snapshot(session.sessionId)
    const input = snapshot.elements.find((element) => element.name === 'Keep my text')!
    const button = snapshot.elements.find((element) => element.name === 'Increment')!
    await pageController.act(session.sessionId, {
      type: 'type',
      ref: input.ref,
      text: 'Preserve this unsaved text',
      clear: true,
    })
    await pageController.act(session.sessionId, { type: 'click', ref: button.ref })
    return { sessionId: session.sessionId, documentId: snapshot.documentId }
  })
  await expect(frame.locator('#count')).toHaveText('2')
  const marker = crypto.randomUUID()
  await iframe.evaluate((element, marker) => element.setAttribute('data-retained-frame', marker), marker)

  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
  await expect(page.locator('[data-page-panel]')).toBeVisible()
  await expect(iframe).toHaveAttribute('data-retained-frame', marker)
  await expect(frame.getByRole('textbox', { name: 'Keep my text' })).toHaveValue('Preserve this unsaved text')
  await page.getByRole('button', { name: 'Show inline', exact: true }).click()
  await expect(page.locator('[data-page-panel]')).toHaveCount(0)
  await expect.poll(async () => (await page.locator('#content-view').boundingBox())?.width).toBeLessThan(1)
  await expect(iframe).toHaveAttribute('data-retained-frame', marker)
  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
  // Frame locators track the inner button; the outer frame must also finish sliding into place.
  await iframe.click({ trial: true })
  await page.getByRole('button', { name: 'Select element on page', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel element selection' })).toBeVisible()
  await frame.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(page.getByTitle('View quote', { exact: true })).toBeVisible()
  await expect(frame.locator('#count')).toHaveText('2')
  await page.getByRole('button', { name: 'Remove quote' }).click()
  await page.getByRole('button', { name: 'Expand page', exact: true }).click()
  await expect(page).toHaveURL(/\/pages\//)
  await expect(iframe).toBeVisible()
  await expect(iframe).toHaveAttribute('data-retained-frame', marker)
  await expect(frame.locator('#count')).toHaveText('2')
  await frame.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(frame.locator('#count')).toHaveText('3')

  const expandedUrl = page.url()
  const opened = await page.evaluate(async (observation) => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    await pageController.selectForAgent(observation.sessionId)
    const retained = await pageController.snapshot(observation.sessionId)
    const pageId = crypto.randomUUID()
    const sessionId = await pageController.openForAgent({
      id: pageId,
      title: 'Agent-opened page',
      source: { kind: 'html', html: '<h1>Opened while expanded</h1>' },
    })
    await pageController.snapshot(sessionId)
    return { pageId, sessionId, documentId: retained.documentId }
  }, observation)
  expect(opened.documentId).toBe(observation.documentId)
  await expect(page).toHaveURL(`/pages/${opened.pageId}`)
  await expect(
    page.frameLocator('[data-page-host] iframe[title="Agent-opened page"]').getByRole('heading', {
      name: 'Opened while expanded',
    }),
  ).toBeVisible()
  const selected = await page.evaluate(async (observation) => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    await pageController.selectForAgent(observation.sessionId)
    const snapshot = await pageController.snapshot(observation.sessionId)
    return snapshot.documentId
  }, observation)
  expect(selected).toBe(observation.documentId)
  await expect(page).toHaveURL(expandedUrl)
  await expect(iframe).toBeVisible()
  await expect(iframe).toHaveAttribute('data-retained-frame', marker)
  await expect(frame.locator('#count')).toHaveText('3')
  await page.evaluate(async (sessionId) => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    await pageController.selectForAgent(sessionId)
    await pageController.snapshot(sessionId)
  }, opened.sessionId)
  await expect(page).toHaveURL(`/pages/${opened.pageId}`)
  await page.evaluate(async (sessionId) => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    await pageController.closeForAgent(sessionId)
  }, opened.sessionId)
  await expect(page).toHaveURL(expandedUrl)
  await expect(iframe).toBeVisible()
  await expect(frame.locator('#count')).toHaveText('3')

  await page.getByRole('tab', { name: 'Stateful counter', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin as app', exact: true }).click()
  await expect(page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Stateful counter' })).toBeVisible()
  await page.getByRole('button', { name: 'Restore to sidebar', exact: true }).click()
  await expect(page).toHaveURL(`/chats/${chatId}`)
  await page.evaluate(async (sessionId) => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    await pageController.selectForAgent(sessionId)
  }, observation.sessionId)
  await expect(page).toHaveURL(`/chats/${chatId}`)
  await expect(frame.getByRole('textbox', { name: 'Keep my text' })).toHaveValue('Preserve this unsaved text')
  await expect(frame.locator('#count')).toHaveText('3')
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Stateful counter' }).click()
  await expect(page).toHaveURL(/\/pages\//)
  await expect(page.getByRole('tablist', { name: 'Browser tabs' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show browser controls' })).toBeVisible()
  await expect(iframe).toHaveAttribute('data-retained-frame', marker)
  await expect(frame.locator('#count')).toHaveText('3')
  expect(
    await page.evaluate(async (observation) => {
      const modulePath = '/src/pages/page-controller.ts'
      const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
      return (await pageController.snapshot(observation.sessionId)).documentId
    }, observation),
  ).toBe(observation.documentId)
  // Reopening a saved HTML page after a reload verifies the snapshot again.
  await page.reload()
  await expect(iframe).toBeVisible()
  await expect(frame.locator('#count')).toHaveText('0')
  await expect(page.getByRole('button', { name: 'Show browser controls' })).toBeVisible()
  // Closing the only expanded tab must exit its route, not restore the saved pin into a new session.
  await page.evaluate(async () => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    const current = pageController.list().find((session) => session.title === 'Stateful counter')!
    await pageController.closeForAgent(current.sessionId)
  })
  await expect(page).toHaveURL(`/chats/${chatId}`)
  await expect(page.locator('[data-page-panel]')).toHaveCount(0)
  await expect(page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Stateful counter' })).toBeVisible()
  expect(errors).toEqual([])
})

test('a synced website pin opens an external browser fallback on web', async ({ page }) => {
  const email = await loginViaEmailCode(page)
  const id = crypto.randomUUID()
  const secondId = crypto.randomUUID()
  const now = new Date().toISOString()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: now,
    user: { id: 'url-page-fixture', email },
    tables: {
      settings: [
        { id, title: 'Example website', url: 'https://example.com/' },
        { id: secondId, title: 'Second website', url: 'https://example.org/' },
      ].map((site) => ({
        key: `saved-page:${site.id}`,
        value: JSON.stringify({
          version: 1,
          id: site.id,
          title: site.title,
          source: { kind: 'url', url: site.url },
          chrome: 'browser',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
      })),
    },
  })
  await page.goto(`/pages/${id}`)
  await expect(page.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute('href', 'https://example.com/')
  await expect(page.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute('target', '_blank')
  await expect(page.getByRole('button', { name: 'Select element on page' })).toBeDisabled()
  await expect(page.locator('[data-page-host] iframe')).toHaveCount(0)
  const panel = page.locator('[data-page-panel]')
  await expect(page.locator('[data-main-header]')).toHaveCount(0)
  const header = await panel.locator('[data-page-header]').boundingBox()
  const address = await panel.locator('[data-page-address-row]').boundingBox()
  const bounds = await panel.boundingBox()
  expect(header!.y).toBe(bounds!.y)
  expect(address!.y).toBeCloseTo(header!.y + header!.height, 0)
  await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'New tab', exact: true })).toBeVisible()
  await expect(panel.locator('[data-browser-page-navigation]')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Browse in the desktop app' })).toContainText('https://example.com/')
  await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'External website' }))
  const opened = page.waitForEvent('popup')
  await panel.getByRole('link', { name: 'Open in your browser' }).click()
  const external = await opened
  await expect(external).toHaveURL('https://example.com/')
  await external.close()
  await expect(page).toHaveURL(`/pages/${id}`)
  const tabs = await panel.getByRole('tab').count()
  const actionBounds = await panel.locator('[data-browser-tab-actions] button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const { x, width } = button.getBoundingClientRect()
      return { x, width }
    }),
  )
  expect(actionBounds).toHaveLength(4)
  const gaps = actionBounds
    .slice(1)
    .map((button, index) => button.x - actionBounds[index].x - actionBounds[index].width)
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1)
  // The panel icon moves the current page into the sidebar instead of opening a hidden blank tab.
  await panel.getByRole('button', { name: 'Restore to sidebar', exact: true }).click()
  await expect(page).toHaveURL('/chats/new')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab')).toHaveCount(tabs)
  await expect(panel.getByRole('button', { name: 'Browse in the desktop app' })).toContainText('https://example.com/')
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Second website' }).click()
  await panel.getByRole('button', { name: 'Restore to sidebar', exact: true }).click()
  await panel.getByRole('tab').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(1)
  await expect(panel.getByRole('tab', { name: 'Second website', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Example website' }).click()
  await panel.getByRole('button', { name: 'Restore to sidebar', exact: true }).click()
  await panel.getByRole('tab').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close all tabs', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(async () => (await page.locator('#content-view').boundingBox())?.width).toBeLessThan(1)
  // Closing tabs keeps the synced pin available, and it can still reopen expanded.
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Example website' }).click()
  await expect(page).toHaveURL(`/pages/${id}`)
  await panel.getByRole('button', { name: 'Restore to sidebar', exact: true }).click()
  await panel.getByRole('button', { name: 'Expand page', exact: true }).click()
  await expect(page).toHaveURL(`/pages/${id}`)
  // Mobile retains access to the left navigation without reintroducing a third row.
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
})

test('pinned pages rename from sidebar and tab menus, retain their names after reload, and support mobile menus', async ({
  page,
}) => {
  const email = await loginViaEmailCode(page)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: now,
    user: { id: 'rename-page-fixture', email },
    tables: {
      settings: [
        {
          key: `saved-page:${id}`,
          value: JSON.stringify({
            version: 1,
            id,
            title: 'Original website',
            source: { kind: 'url', url: 'https://example.com/' },
            chrome: 'browser',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }),
        },
      ],
    },
  })
  await page.goto(`/pages/${id}`)
  const row = page.locator(`[data-saved-page-id="${id}"]`)
  const name = row.locator('[data-sidebar="menu-button"]')
  await name.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename pinned page', exact: true })
  const input = dialog.getByRole('textbox', { name: 'Page name' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Original website')
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([
    0,
    'Original website'.length,
  ])
  await input.fill('Discard this draft')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(name).toHaveText('Original website')
  await row.hover()
  await row.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(input).toHaveValue('Original website')
  await input.fill('   ')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await input.fill('  My reference  ')
  await input.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(name).toHaveText('My reference')
  const panel = page.locator('[data-page-panel]')
  await expect(panel.getByRole('tab', { name: 'My reference', exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: 'My reference', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(input).toBeFocused()
  await input.fill('Research library')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(name).toHaveText('Research library')
  await expect(panel.getByRole('tab', { name: 'Research library', exact: true })).toBeVisible()
  await page.reload()
  await expect(name).toHaveText('Research library')
  await expect(panel.getByRole('tab', { name: 'Research library', exact: true })).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute(
    'href',
    'https://example.com/',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
  await row.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(input).toBeFocused()
  await input.fill('Mobile reference')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(name).toHaveText('Mobile reference')
})

test('deleting a chat with the browser open never leaves an empty reserved panel', async ({ page }) => {
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'delete-chat-page-fixture', email },
    tables: { chat_threads: [{ id: chatId, title: 'Delete with browser open' }] },
  })
  await page.goto(`/chats/${chatId}`)
  await page.locator('textarea').waitFor()
  await page.evaluate(async () => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    pageController.open({
      id: crypto.randomUUID(),
      title: 'Test page',
      source: { kind: 'url', url: 'https://example.com/' },
    })
  })
  const panel = page.locator('[data-page-panel]')
  await expect(panel).toBeVisible()
  await page
    .locator('[data-sidebar="menu-button"]')
    .filter({ hasText: 'Delete with browser open' })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Delete this chat?' })
    .getByRole('button', { name: 'Delete Chat', exact: true })
    .click()
  await expect(page).toHaveURL('/chats/new')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Close browser', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(async () => (await page.locator('#content-view').boundingBox())?.width).toBeLessThan(1)
})

test('project creation fixes its environment while standalone chats keep the environment chooser', async ({ page }) => {
  await loginViaEmailCode(page)
  await page.getByRole('button', { name: 'Project options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create project', exact: true })
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Fixed environment')
  await expect(dialog.getByRole('button', { name: 'Project environment', exact: true })).toHaveText('Local sandbox')
  await expect(
    dialog.getByText('Every chat in this project uses this environment. It cannot be changed after creation.'),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/new\?projectId=/)
  await page.getByRole('button', { name: 'Agent location', exact: true }).click()
  await expect(page.getByText('Set when this project was created', { exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem').filter({ hasText: 'Local sandbox' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('Cloud', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByRole('button', { name: 'Agent location', exact: true }).click()
  await expect(page.getByText('Set when this project was created', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  // A reply/compaction owns its environment until it finishes; the picker explains a rejected move.
  await page.evaluate(async () => {
    const modulePath = '/src/chats/chat-store.ts'
    const { useChatStore } = (await import(modulePath)) as typeof import('../src/chats/chat-store')
    const store = useChatStore.getState()
    store.updateSession(store.currentSessionId!, { compactionStatus: 'compacting' })
  })
  await page.locator('[data-slot="popover-trigger"]').filter({ hasText: 'Fixed environment' }).click()
  await page.getByRole('button', { name: 'Remove from project', exact: true }).click()
  const moveError = page.getByRole('alertdialog', { name: 'Could not move chat' })
  await expect(moveError).toContainText('Stop the current reply before moving this chat to another project.')
  await moveError.getByRole('button', { name: 'Close', exact: true }).click()
  await page.evaluate(async () => {
    const modulePath = '/src/chats/chat-store.ts'
    const { useChatStore } = (await import(modulePath)) as typeof import('../src/chats/chat-store')
    const store = useChatStore.getState()
    store.updateSession(store.currentSessionId!, { compactionStatus: 'idle' })
  })
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Agent location', exact: true }).click()
  await expect(page.getByText('Set when this project was created', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Cloud', { exact: true })).toBeVisible()
})

test('deleting a project frees open and cached chats to use standalone environments', async ({ page }) => {
  const email = await loginViaEmailCode(page)
  const projectId = crypto.randomUUID()
  const chatIds = [crypto.randomUUID(), crypto.randomUUID()]
  const names = ['Previously opened project chat', 'Currently open project chat']
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'delete-project-fixture', email },
    tables: {
      projects: [{ id: projectId, name: 'Delete this workspace' }],
      chat_threads: chatIds.map((id, index) => ({ id, title: names[index], projectId })),
      settings: [{ key: `project-execution:${projectId}`, value: JSON.stringify({ version: 1, location: 'sandbox' }) }],
    },
  })
  await page.goto(`/chats/${chatIds[0]}`)
  await page.locator('textarea').waitFor()
  const chatRow = (name: string) => page.locator('[data-sidebar="menu-button"]').filter({ hasText: name })
  await chatRow(names[1]).click()
  await expect(page).toHaveURL(`/chats/${chatIds[1]}`)
  await page.getByRole('button', { name: 'Agent location', exact: true }).click()
  await expect(page.getByText('Set when this project was created', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page
    .locator('#sidebar-projects')
    .getByRole('button', { name: 'Delete this workspace', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Delete this project?' })
    .getByRole('button', { name: 'Delete project', exact: true })
    .click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)

  // Navigation reuses the existing chat instances; no reload may hide a stale session.
  for (const [index, name] of names.entries()) {
    await chatRow(name).click()
    await expect(page).toHaveURL(`/chats/${chatIds[index]}`)
    await page.getByRole('button', { name: 'Agent location', exact: true }).click()
    await expect(page.getByText('Set when this project was created', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Cloud', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  }
  expect(
    await page.evaluate(async (ids) => {
      const modulePath = '/src/chats/chat-store.ts'
      const { useChatStore } = (await import(modulePath)) as typeof import('../src/chats/chat-store')
      return ids.map((id) => {
        const session = useChatStore.getState().sessions.get(id)!
        return { projectId: session.projectId, savedProjectId: session.chatThread?.projectId }
      })
    }, chatIds),
  ).toEqual(chatIds.map(() => ({ projectId: null, savedProjectId: null })))
})

test('historical mini-app chats remain ordinary chats without the retired app registry', async ({ page }) => {
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'historical-app-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Historical app conversation', miniAppId: 'retired-app' }],
      chat_messages: [
        {
          id: crypto.randomUUID(),
          chatThreadId: chatId,
          parentId: null,
          role: 'user',
          content: 'Keep the saved conversation.',
          parts: [{ type: 'text', text: 'Keep the saved conversation.' }],
          createdAt: new Date().toISOString(),
        },
      ],
    },
  })
  const registryRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/mini-apps')) {
      registryRequests.push(request.url())
    }
  })
  await page.goto(`/chats/${chatId}`)
  await expect(page.getByText('Keep the saved conversation.', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`))
  await expect(page.getByText('Open app', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New Chat', exact: true }).first().click()
  await expect(page.getByText('Keep the saved conversation.', { exact: true })).toBeHidden()
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.locator('textarea')).toBeFocused()
  await page.getByText('Historical app conversation', { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`))
  expect(registryRequests).toEqual([])
})
