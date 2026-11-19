/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, openSidebarOnMobile } from './helpers'

test('search indexes a new message and a renamed chat while preserving both after reload', async ({ page }) => {
  const errors = collectPageErrors(page)
  const mobile = (page.viewportSize()?.width ?? 1280) < 768
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const prompt = `Searchalpha${suffix}`
  const renamedTitle = `Searchbeta${suffix}`
  await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('textarea').fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  const chatUrl = page.url()

  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Search', exact: true })
  const query = search.getByRole('combobox')
  await query.fill(prompt)
  // The initial title and the new user message are independently indexed.
  await expect(search.getByRole('option').filter({ hasText: prompt })).toHaveCount(2)
  await page.keyboard.press('Escape')

  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: prompt, exact: true }).click({ button: 'right' })
  await page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename chat', exact: true })
  await rename.getByRole('textbox', { name: 'Chat name', exact: true }).fill(renamedTitle)
  await rename.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rename).toBeHidden()
  if (mobile) {
    await page.keyboard.press('Escape')
  }

  await page.keyboard.press('ControlOrMeta+k')
  await query.fill(renamedTitle)
  await expect(search.getByRole('option').filter({ hasText: renamedTitle })).toHaveCount(1)
  await query.fill(prompt)
  await expect(search.getByRole('option').filter({ hasText: prompt })).toHaveCount(1)
  await search.getByRole('option').filter({ hasText: prompt }).click()
  await expect(search).toBeHidden()
  await expect(page).toHaveURL(chatUrl)
  await expect(page.locator('[data-message-id]').getByText(prompt, { exact: true })).toBeInViewport()

  await page.reload()

  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  await page.keyboard.press('ControlOrMeta+k')
  await query.fill(renamedTitle)
  await expect(search.getByRole('option').filter({ hasText: renamedTitle })).toHaveCount(1)
  await query.fill(prompt)
  await expect(search.getByRole('option').filter({ hasText: prompt })).toHaveCount(1)
  expect(errors).toEqual([])
})
