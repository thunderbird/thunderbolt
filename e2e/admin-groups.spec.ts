/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import { adminRouteStatus, adminTest as test, uniqueName } from './admin/helpers'

test('mapping a group to admin makes its members admins, and unmapping takes it away', async ({
  page,
  adminApi,
  request,
}) => {
  const member = await adminApi.seedMember()
  const groupName = uniqueName('Group')
  const adminStatus = () => adminRouteStatus(request, member.token)

  await page.goto('/admin/groups')
  await page.getByRole('button', { name: 'New group' }).click()
  await page.getByLabel('Group name').fill(groupName)
  await page.getByRole('button', { name: 'Create group' }).click()
  const adminSwitch = page.getByRole('switch', { name: `Make members of ${groupName} admins` })
  await expect(adminSwitch).toBeVisible()
  const groupId = new URL(page.url()).searchParams.get('edit')

  await page.getByRole('button', { name: 'Add members' }).click()
  await page.getByRole('searchbox', { name: 'Search by name or email' }).fill(member.email)
  await page.getByRole('dialog', { name: 'Add members' }).getByText(member.email, { exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /from the group$/ })).toHaveCount(1)

  await adminSwitch.click()
  await expect(adminSwitch).toBeChecked()
  expect(await adminStatus()).toBe(200)

  await page.goto(`/admin/members?edit=${member.userId}`)
  await expect(page.getByText(/From the group/)).toBeVisible()
  await expect(page.getByRole('link', { name: groupName })).toHaveCount(2)

  await page.goto(`/admin/groups?edit=${groupId}`)
  await adminSwitch.click()
  await expect(adminSwitch).not.toBeChecked()
  expect(await adminStatus()).toBe(403)
})

test('an admin renames a group, removes a member and deletes the group', async ({ page, adminApi }) => {
  const member = await adminApi.seedMember()
  const group = await adminApi.seedGroup({ memberIds: [member.userId] })
  const renamed = uniqueName('Renamed')

  await page.goto(`/admin/groups?edit=${group.id}`)
  await page.getByLabel('Group name').fill(renamed)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible()

  await page.getByRole('button', { name: /from the group$/ }).click()
  await expect(page.getByText(`No one is in ${renamed} yet.`)).toBeVisible()

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Delete group' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete group' }).click()
  await expect(page).toHaveURL(/\/admin\/groups$/)
  await expect(page.getByRole('button', { name: renamed, exact: true })).toHaveCount(0)
})
