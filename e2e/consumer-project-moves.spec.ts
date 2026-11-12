/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'

/** Seed only isolated browser-test data; every move itself goes through the real UI. */
const seedMoveFixture = async (page: Page) => {
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const firstProject = crypto.randomUUID()
  const secondProject = crypto.randomUUID()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'project-move-fixture', email },
    tables: {
      projects: [
        { id: firstProject, name: 'First workspace' },
        { id: secondProject, name: 'Second workspace' },
      ],
      chat_threads: [{ id: chatId, title: 'Move this conversation' }],
    },
  })
  await page.goto(`/chats/${chatId}`)
  await page.locator('textarea').waitFor()
}

const confirmation = (page: Page) => page.getByRole('alertdialog', { name: 'Move chat to a different environment?' })
const chatRow = (page: Page) =>
  page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Move this conversation' })
const projectBadge = (page: Page, name: string) =>
  page.locator('[data-slot="popover-trigger"]').filter({ hasText: name })

/** Exercise the sidebar's context-menu path, separate from the header's project picker. */
const chooseSidebarMove = async (page: Page, name: string) => {
  await chatRow(page).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click()
  await page.getByRole('dialog', { name: 'Move', exact: true }).getByRole('button', { name, exact: true }).click()
}

test('sidebar and header moves explain environment boundaries and allow cancellation', async ({ page }) => {
  await seedMoveFixture(page)
  await chooseSidebarMove(page, 'First workspace')
  await expect(confirmation(page)).toContainText('Only the chat context will move.')
  await expect(confirmation(page)).toContainText(
    'Files, running apps, and other environment state will stay in the original environment.',
  )
  await confirmation(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible()
  await chooseSidebarMove(page, 'First workspace')
  await confirmation(page).getByRole('button', { name: 'Move chat', exact: true }).click()
  await expect(projectBadge(page, 'First workspace')).toBeVisible()

  await projectBadge(page, 'First workspace').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Second workspace', exact: true }).click()
  await expect(confirmation(page)).toBeVisible()
  await confirmation(page).getByRole('button', { name: 'Move chat', exact: true }).click()
  await expect(projectBadge(page, 'Second workspace')).toBeVisible()
  await projectBadge(page, 'Second workspace').click()
  await page.getByRole('button', { name: 'Remove from project', exact: true }).click()
  await expect(confirmation(page)).toBeVisible()
  await confirmation(page).getByRole('button', { name: 'Move chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible()
  await expect(chatRow(page)).toBeVisible()
})

test('dragging a chat to a project asks before changing its workspace', async ({ page }) => {
  await seedMoveFixture(page)
  const source = await chatRow(page).boundingBox()
  const target = await page
    .locator('#sidebar-projects')
    .getByRole('button', { name: 'First workspace', exact: true })
    .boundingBox()
  if (!source || !target) {
    throw new Error('Expected the chat and project drop target to be visible')
  }
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 })
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(confirmation(page)).toBeVisible()
  await confirmation(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toBeVisible()
})
