/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page, type ViewportSize } from '@playwright/test'
import { adminAppUrl, adminTest as test, e2eSignInCode, readInviteUrl, uniqueEmail } from './admin/helpers'

/** Invite `email` from the Members screen. */
const invite = async (page: Page, email: string) => {
  await page.getByRole('button', { name: 'Invite member' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible()
}

/** The Members row for `email`: an invitation or, once they sign in, the member. */
const row = (page: Page, email: string) =>
  page.locator('[data-slot="card"]', { has: page.getByRole('button', { name: email, exact: true }) })

/** A page signed in as nobody, in this project's viewport. */
const openSignedOut = async (browser: Browser, viewport: ViewportSize | null) => {
  const context = await browser.newContext({
    baseURL: adminAppUrl,
    viewport,
    storageState: { cookies: [], origins: [] },
  })
  return { page: await context.newPage(), close: () => context.close() }
}

test('an invitation shows in Members as pending, and its link signs the person in as a member', async ({
  page,
  browser,
  viewport,
}) => {
  const email = uniqueEmail('invitee')
  await page.goto('/admin/members')
  await invite(page, email)
  await expect(page).toHaveURL(/\/admin\/members$/)
  await expect(row(page, email)).toContainText('Invitation expires')

  const invitee = await openSignedOut(browser, viewport)
  await invitee.page.goto(await readInviteUrl(email))
  await expect(invitee.page.getByRole('heading', { name: /You've been invited to/ })).toBeVisible()
  await expect(invitee.page.getByPlaceholder('Email', { exact: true })).toHaveValue(email)
  await invitee.page.getByRole('button', { name: 'Continue', exact: true }).click()
  await invitee.page.locator('input[data-input-otp]').fill(e2eSignInCode)
  await expect(invitee.page.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await invitee.close()

  await page.reload()
  await expect(row(page, email)).toHaveCount(1)
  await expect(row(page, email)).not.toContainText('Invitation expires')
})

test('a revoked invitation link is refused', async ({ page, browser, viewport }) => {
  const email = uniqueEmail('revoked')
  await page.goto('/admin/members')
  await invite(page, email)
  const inviteUrl = await readInviteUrl(email)

  await page.getByRole('button', { name: email, exact: true }).click()
  await page.getByRole('button', { name: 'Revoke invitation' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke invitation' }).click()
  await expect(page.getByText(`Invitation to ${email} revoked.`)).toBeVisible()
  await expect(row(page, email)).toHaveCount(0)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Show revoked invitations' }).click()
  await expect(row(page, email)).toContainText('Revoked')

  const invitee = await openSignedOut(browser, viewport)
  await invitee.page.goto(inviteUrl)
  await expect(
    invitee.page.getByRole('heading', { name: 'This invitation is no longer valid', exact: true }),
  ).toBeVisible()
  await invitee.close()
})

test('Members opens the invite form in place', async ({ page }) => {
  await page.goto('/admin/members')
  await page.getByRole('button', { name: 'Invite member' }).click()

  await expect(page).toHaveURL(/\/admin\/members\?edit=new$/)
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible()
})
