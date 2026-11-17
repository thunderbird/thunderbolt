/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'
import type { AuditEventPage } from '../shared/admin-api'
import { adminTest as test } from './admin/helpers'

/** The audit rows: list items with a time, unlike the sidebar's. */
const eventRows = (page: Page) => page.getByRole('listitem').filter({ has: page.locator('time') })

/** Narrow screens fold the filters behind a button. */
const showFilters = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 768) < 768) {
    await page.getByRole('button', { name: /^Filters/ }).click()
  }
}

const pick = async (page: Page, filter: string, option: string) => {
  await page.getByRole('combobox', { name: filter }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** The page has rendered its list, or its empty message. */
const expectListed = (page: Page) =>
  expect(eventRows(page).first().or(page.getByText('No events match these filters.'))).toBeVisible()

test('an admin action shows up after one refresh, and the action filter narrows to it', async ({ page, adminApi }) => {
  await page.goto('/admin/audit-log')
  await expectListed(page)

  const group = await adminApi.seedGroup()
  await page.getByRole('button', { name: 'Refresh' }).click()
  const created = eventRows(page).filter({ hasText: group.id })
  await expect(created).toContainText('Group created')

  await showFilters(page)
  await pick(page, 'Action', 'Group created')
  await expect(page).toHaveURL(/[?&]action=local_group\.created/)
  await expect(created).toBeVisible()
  await expect(eventRows(page).filter({ hasNotText: 'Group created' })).toHaveCount(0)
})

test('a link to one target lists it alone, and outcome and date filters narrow it away', async ({ page, adminApi }) => {
  const group = await adminApi.seedGroup()
  const targetLink = `/admin/audit-log?targetType=local_group&targetId=${group.id}`

  await page.goto(targetLink)
  await expect(eventRows(page)).toHaveCount(1)
  await expect(eventRows(page)).toContainText('Group created')
  await expect(page.getByText(`Target: ${group.id}`)).toBeVisible()

  await showFilters(page)
  await pick(page, 'Outcome', 'Denied')
  await expect(page.getByText('No events match these filters.')).toBeVisible()

  await page.goto(targetLink)
  await expect(eventRows(page)).toHaveCount(1)
  await showFilters(page)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const day = (value: number) => String(value).padStart(2, '0')
  await page
    .getByLabel('From')
    .fill(`${tomorrow.getFullYear()}-${day(tomorrow.getMonth() + 1)}-${day(tomorrow.getDate())}`)
  await expect(page).toHaveURL(/[?&]from=/)
  await expect(page.getByText('No events match these filters.')).toBeVisible()
})

test("a sign-in shows its person as actor, with the client's details", async ({ page, adminApi }) => {
  const member = await adminApi.seedMember()
  const { events } = await adminApi.request<AuditEventPage>(
    'GET',
    `admin/audit-events?action=auth.sign_in&actorId=${member.userId}`,
  )
  const [signIn] = events
  expect(signIn.userAgent).toBeTruthy()

  await page.goto('/admin/audit-log')
  await showFilters(page)
  await page.getByRole('combobox', { name: 'Actor' }).click()
  await page.getByPlaceholder('Search by name or email').fill(member.email)
  await page.getByRole('option').filter({ hasText: member.email }).click()
  await pick(page, 'Action', 'Signed in')

  await expect(page).toHaveURL(new RegExp(`[?&]actorId=${member.userId}`))
  const row = eventRows(page).filter({ hasText: member.userId })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Person')
  await expect(row).toContainText(signIn.userAgent ?? '')
  if (signIn.ipAddress) {
    await expect(row).toContainText(signIn.ipAddress)
  }
})
