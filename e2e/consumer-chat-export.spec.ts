/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, openSidebarOnMobile, sendChatPrompt } from './helpers'
import { expect, isolateProviderRequests, test, type Page } from './test'

type ChatFile = {
  kind?: string
  user: { email: string | null }
  tables: Record<string, Array<{ id: string; title?: string; chatThreadId?: string }>>
}

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768

/** Opens the chat's menu (right-click on desktop, the action sheet on mobile) and picks an action. */
const chooseChatAction = async (page: Page, title: string, action: string) => {
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: title, exact: true }).click({ button: 'right' })
  await page.getByRole(isMobile(page) ? 'button' : 'menuitem', { name: action, exact: true }).click()
}

/**
 * Opens the given sidebar section and leaves the page as it is. Navigation stays in-app: a private WebKit context
 * has no OPFS, so its database lives in memory, and a page load empties it unless sync has restored it.
 */
const openSidebarSection = async (page: Page, section: 'Chats' | 'Settings') => {
  await openSidebarOnMobile(page)
  await page.getByRole('navigation', { name: 'Sidebar sections' }).getByRole('button', { name: section }).click()
}

/** Picks the file in Settings → Preferences → Data → Import Data and confirms the single-chat dialog. */
const importChatFile = async (page: Page, contents: string, fromEmail: string) => {
  await openSidebarSection(page, 'Settings')
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
    name: 'chat.json',
    mimeType: 'application/json',
    buffer: Buffer.from(contents),
  })
  const dialog = page.getByRole('alertdialog', { name: 'Import this chat?' })
  await expect(
    dialog.getByText(`This chat was exported by a different account (${fromEmail}).`, { exact: true }),
  ).toBeVisible()
  await expect(dialog.getByText(/Importing it adds a copy of this chat\./)).toBeVisible()
  await expect(dialog.getByText(/it's updated/)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.locator('#import-data-success')).toBeVisible({ timeout: 60_000 })
}

test('a chat exported from its menu imports into another account as a copy, once', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const errors = collectPageErrors(page)
  const title = `Exportable${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const emailA = await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
  await sendChatPrompt(page, title)
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)

  const [saved] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    chooseChatAction(page, title, 'Export'),
  ])
  expect(saved.suggestedFilename()).toMatch(new RegExp(`^thunderbolt-chat-${title}-\\d{4}-\\d{2}-\\d{2}\\.json$`))
  const contents = await readFile(await saved.path(), 'utf8')
  const file = JSON.parse(contents) as ChatFile
  expect(file.kind).toBe('chat')
  expect(file.user.email).toBe(emailA)
  expect(contents).not.toContain('"userId"')
  expect(Object.keys(file.tables).sort()).toEqual(['chat_messages', 'chat_threads'])
  expect(file.tables.chat_threads).toHaveLength(1)
  expect(file.tables.chat_threads[0].title).toBe(title)
  expect(file.tables.chat_messages.length).toBeGreaterThanOrEqual(2)

  if (!baseURL) {
    throw new Error('The consumer project needs a baseURL')
  }
  const otherAccount = await browser.newContext({ baseURL })
  try {
    await isolateProviderRequests(otherAccount, testInfo.project.name)
    const pageB = await otherAccount.newPage()
    const errorsB = collectPageErrors(pageB)
    await loginViaEmailCode(pageB)

    await importChatFile(pageB, contents, emailA)
    await expect(pageB.locator('#import-data-success')).toHaveText(`Imported a copy of the chat “${title}”.`)
    await openSidebarSection(pageB, 'Chats')
    await pageB.getByRole('button', { name: title, exact: true }).click()
    await expect(pageB.locator('[data-message-id]').getByText(title, { exact: true })).toBeVisible()
    await expect(pageB.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
    // The copy has ids of its own, so the other account's chat is never overwritten.
    expect(pageB.url()).not.toContain(file.tables.chat_threads[0].id)

    // Importing the same file again updates the copy rather than adding a second one.
    await importChatFile(pageB, contents, emailA)
    await openSidebarSection(pageB, 'Chats')
    await expect(pageB.getByRole('button', { name: title, exact: true })).toHaveCount(1)
    expect(errorsB).toEqual([])
  } finally {
    await otherAccount.close()
  }
  expect(errors).toEqual([])
})
