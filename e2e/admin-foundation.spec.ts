/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'
import { openSidebarOnMobile } from './helpers'
import { adminBackendUrl, adminTest as test, openAdminSection, readInviteUrl, uniqueEmail } from './admin/helpers'

const screens = ['Members', 'Groups', 'Sign-in methods', 'Audit log']

const sectionToggle = (page: Page) => page.getByRole('navigation', { name: 'Sidebar sections' })

/** The toggle is up (the mount signal), and offers Admin or not. */
const expectAdminEntry = async (page: Page, visible: boolean) => {
  await openSidebarOnMobile(page)
  await expect(sectionToggle(page).getByRole('button', { name: 'Chats' })).toBeVisible()
  await expect(sectionToggle(page).getByRole('button', { name: 'Admin' })).toHaveCount(visible ? 1 : 0)
}

test('a bootstrap admin reaches every admin screen from the sidebar', async ({ page }) => {
  await page.goto('/')
  await openAdminSection(page)

  for (const screen of screens) {
    await openSidebarOnMobile(page)
    await page.locator('[data-sidebar="menu-button"]', { hasText: screen }).click()
    await expect(page.getByRole('heading', { name: screen, exact: true, level: 1 })).toBeVisible()
  }
  await expect(page).toHaveURL(/\/admin\/audit-log$/)
})

test('a member sees no admin entry, is sent home from /admin, and gets 403 from the API', async ({
  memberPage,
  request,
}) => {
  const member = await memberPage()

  await expectAdminEntry(member.page, false)
  await member.page.goto('/admin/members')
  await expect(member.page).toHaveURL(/\/chats\/new$/)

  const response = await request.get(`${adminBackendUrl}/v1/admin/members`, {
    headers: { Authorization: `Bearer ${member.token}` },
  })
  expect(response.status()).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'ADMIN_REQUIRED' })
})

test('revoking admin hides the admin UI on the next session read', async ({ memberPage, adminApi }) => {
  const member = await memberPage()
  const { userId } = await adminApi.findMember(member.email)

  await adminApi.grantAdmin(userId)
  await member.page.reload()
  await expectAdminEntry(member.page, true)

  await adminApi.revokeAdmin(userId)
  await member.page.reload()
  await expectAdminEntry(member.page, false)
  await member.page.goto('/admin/members')
  await expect(member.page).toHaveURL(/\/chats\/new$/)
})

test('the dev log carries the link of an invitation', async ({ adminApi }) => {
  const email = uniqueEmail('invitee')
  await adminApi.request('POST', 'admin/invitations', { email })

  expect(await readInviteUrl(email)).toMatch(/^http:\/\/localhost:1427\/invite\/\S+$/)
})
