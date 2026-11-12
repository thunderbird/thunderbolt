/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'

test('project permissions can be chosen at creation and edited without changing its environment', async ({ page }) => {
  await loginViaEmailCode(page)
  await page.getByRole('button', { name: 'Project options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'Create project', exact: true })
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill('Permission test project')
  await expect(create.getByLabel('Agent permissions')).toHaveText('Ask for approval')
  await create.getByLabel('Agent permissions').click()
  await page.getByRole('menuitem', { name: /Full access/ }).click()
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/new\?projectId=/)
  await expect(page.getByRole('button', { name: 'Agent access', exact: true })).toHaveAttribute('title', 'Full access')

  const openSettings = async () => {
    await page.locator('[data-slot="popover-trigger"]').filter({ hasText: 'Permission test project' }).click()
    await page.getByRole('button', { name: 'Configure Permission test project', exact: true }).click()
    return page.getByRole('dialog', { name: 'Project settings', exact: true })
  }
  const settings = await openSettings()
  await expect(settings.getByLabel('Project environment')).toHaveText('Local sandbox')
  await expect(settings.getByRole('button', { name: 'Project environment', exact: true })).toHaveCount(0)
  await expect(settings.getByLabel('Agent permissions')).toHaveText('Full access')
  await settings.getByLabel('Agent permissions').click()
  await page.getByRole('menuitem', { name: /Ask for approval/ }).click()
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Agent access', exact: true })).toHaveAttribute('title', 'Full access')
  await openSettings()
  await settings.getByLabel('Agent permissions').click()
  await page.getByRole('menuitem', { name: /Ask for approval/ }).click()
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Agent access', exact: true })).toHaveAttribute(
    'title',
    'Ask for approval',
  )
  await page.reload()
  await expect(page.getByRole('button', { name: 'Agent access', exact: true })).toHaveAttribute(
    'title',
    'Ask for approval',
  )
  await openSettings()
  await expect(settings.getByLabel('Agent permissions')).toHaveText('Ask for approval')
})
