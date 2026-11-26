/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import {
  adminRouteStatus,
  adminTest as test,
  choosePanelAction,
  openAdminRow,
  openMember,
  uniqueName,
} from './admin/helpers'

test('mapping a group to admin makes its members admins, and unmapping takes it away', async ({
  page,
  adminApi,
  request,
}) => {
  const member = await adminApi.seedMember()
  const groupName = uniqueName('Group')
  const adminStatus = () => adminRouteStatus(request, member.token)

  await page.goto('/admin/groups')
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Name', { exact: true }).fill(groupName)
  const adminSwitch = page.getByRole('switch', { name: 'Admin group' })
  await adminSwitch.click()
  await page.getByRole('combobox', { name: 'Add member' }).click()
  await page.getByPlaceholder('Search by name or email').fill(member.email)
  await page.getByRole('option').filter({ hasText: member.email }).click()
  await expect(page.getByRole('button', { name: /from the group$/ })).toHaveCount(1)
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  // Saved: the panel switches to the group's view, whose subtitle says it's an admin group.
  await expect(page.getByRole('heading', { name: 'Create Group' })).toHaveCount(0)
  await expect(page.getByText('Admin group', { exact: true })).toBeVisible()
  expect(await adminStatus()).toBe(200)

  await openMember(page, member.email)
  await expect(page.getByRole('link', { name: groupName })).toHaveCount(2)

  // The member's link opens the group on Groups.
  await page.getByRole('link', { name: groupName }).first().click()
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible()
  await choosePanelAction(page, 'Edit')
  await adminSwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // Saved: the edit form gives way to the view, which no longer says it's an admin group.
  await expect(page.getByRole('heading', { name: 'Edit Group' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible()
  await expect(page.getByText('Admin group', { exact: true })).toHaveCount(0)
  expect(await adminStatus()).toBe(403)
})

test('an admin renames a group, removes a member and deletes the group', async ({ page, adminApi }) => {
  const member = await adminApi.seedMember()
  const group = await adminApi.seedGroup({ memberIds: [member.userId] })
  const renamed = uniqueName('Renamed')

  await openAdminRow(page, '/admin/groups', group.name)
  await choosePanelAction(page, 'Edit')
  await page.getByLabel('Name', { exact: true }).fill(renamed)
  await page.getByRole('button', { name: /from the group$/ }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible()
  await expect(page.getByText('No members yet', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete group' }).click()
  await expect(page).toHaveURL(/\/admin\/groups$/)
  await expect(page.getByRole('button', { name: `Open ${renamed}`, exact: true })).toHaveCount(0)
})
