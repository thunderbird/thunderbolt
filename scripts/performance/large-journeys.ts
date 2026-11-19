/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'
import { openSidebarOnMobile } from '../../e2e/helpers'
import type { MeasureScenario } from './scenarios'
import { archiveSearchTerm, type prepareLargeAccount } from './large-fixture'
import { clickAction } from './driver'

type Fixture = Awaited<ReturnType<typeof prepareLargeAccount>>

/** Keep the same SPA and hydrated session map alive while returning to a fixed empty checkpoint chat. */
export const visitSidebarChat = async (page: Page, chat: { id: string; title: string; finalHeading?: string }) => {
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: chat.title, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}$`))
  await expect(page.locator('textarea')).toBeEditable()
  if (chat.finalHeading) {
    await expect(page.getByRole('heading', { name: chat.finalHeading, exact: true })).toBeVisible()
  } else {
    await expect(page.locator('[data-quotable-message-id]')).toHaveCount(0)
  }
}

/** Exercise large-account navigation and search without adding messages or creating new draft sessions. */
export const runLargeCycle = async (page: Page, fixture: Fixture, cycle: number, measure: MeasureScenario) => {
  const mobile = page.viewportSize()!.width < 768
  if (mobile) {
    const open = await clickAction(
      page,
      page.locator('[data-slot="create-item-layout"] header').first().getByRole('button').first(),
    )
    await measure('sidebar-open', open, 500)
    const drawer = page.locator('[data-slot="sidebar"][data-mobile="true"][data-open]')
    await expect(drawer).toBeVisible()
    await measure('sidebar-close', () => page.keyboard.press('Escape'), 500)
    await expect(drawer).toHaveCount(0)
  } else {
    const toggle = page.getByRole('button', { name: 'Toggle Sidebar', exact: true })
    await measure('sidebar-collapse', await clickAction(page, toggle), 500)
    await expect(page.locator('[data-side="left"][data-state="collapsed"]')).toBeVisible()
    await measure('sidebar-expand', await clickAction(page, toggle), 500)
    await expect(page.locator('[data-side="left"][data-state="expanded"]')).toBeVisible()
  }

  const dialog = page.getByRole('dialog', { name: 'Search', exact: true })
  await measure('search-open', () => page.keyboard.press('ControlOrMeta+k'), 500)
  const search = dialog.getByRole('combobox')
  await expect(search).toBeVisible()
  await search.focus()
  await measure('search-broad-query', async () => {
    await page.keyboard.insertText(archiveSearchTerm)
    await page.waitForFunction(
      (term) =>
        [...document.querySelectorAll('[data-slot="command-item"]')].some((item) => item.textContent?.includes(term)),
      archiveSearchTerm,
      { polling: 50 },
    )
  })
  await expect(dialog.getByRole('option').filter({ hasText: archiveSearchTerm }).first()).toBeVisible()

  const target = fixture.longChats[cycle % fixture.longChats.length]!
  await measure('search-target-query', async () => {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(target.title)
    await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll('[data-slot="command-item"]')].some((item) =>
          item.getAttribute('data-value')?.includes(id),
        ),
      target.id,
      { polling: 50 },
    )
  })
  const result = dialog.locator(`[data-slot="command-item"][data-value*="${target.id}"]`)
  const select = await clickAction(page, result)
  await measure('search-open-history', async () => {
    await select()
    await page.waitForFunction(
      (heading) => {
        const headings = document.querySelectorAll('[data-quotable-message-id] h3')
        return headings[headings.length - 1]?.textContent === heading
      },
      target.finalHeading,
      { polling: 50 },
    )
  })
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/chats/${target.id}$`))
  await expect(page.getByRole('heading', { name: target.finalHeading, exact: true })).toBeVisible()

  const composer = page.locator('textarea')
  const draft = 'A short draft stays editable with a large archive open.'
  await composer.focus()
  await measure('history-typing', () => page.keyboard.type(draft, { delay: 10 }))
  await expect(composer).toHaveValue(draft)
  await expect(composer).toBeFocused()
  await composer.fill('')

  const openModel = await clickAction(page, page.getByTestId('model-selector-trigger'))
  await measure('model-menu-open', openModel, 500)
  await expect(page.getByPlaceholder('Search Models', { exact: true })).toBeVisible()
  await measure('model-menu-close', () => page.keyboard.press('Escape'), 500)
  await expect(page.getByPlaceholder('Search Models', { exact: true })).toBeHidden()
  await visitSidebarChat(page, fixture.checkpoint)
  await page.waitForTimeout(500)
}
