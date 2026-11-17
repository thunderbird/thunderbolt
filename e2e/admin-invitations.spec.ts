/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page, type ViewportSize } from '@playwright/test'
import { adminAppUrl, adminTest as test, readInviteUrl, uniqueEmail } from './admin/helpers'

// Matches testSignInOtp in backend/src/auth/otp-constants.ts (NODE_ENV=test only).
const signInCode = '12345678'

/** Invite `email` from the Invitations screen. */
const invite = async (page: Page, email: string) => {
  await page.getByRole('button', { name: 'Invite member' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible()
}

/** A page signed in as nobody, in this project's viewport. */
const openSignedOut = async (browser: Browser, viewport: ViewportSize | null) => {
  const context = await browser.newContext({
    baseURL: adminAppUrl,
    viewport,
    storageState: { cookies: [], origins: [] },
  })
  return { page: await context.newPage(), close: () => context.close() }
}

test('an invitation shows as pending, its link signs the person in, and it then shows as accepted', async ({
  page,
  browser,
  viewport,
}) => {
  const email = uniqueEmail('invitee')
  await page.goto('/admin/invitations')
  await invite(page, email)
  await expect(page.getByLabel(email, { exact: true })).toBeVisible()

  const invitee = await openSignedOut(browser, viewport)
  await invitee.page.goto(await readInviteUrl(email))
  await expect(invitee.page.getByRole('heading', { name: /You've been invited to/ })).toBeVisible()
  await expect(invitee.page.getByPlaceholder('Email', { exact: true })).toHaveValue(email)
  await invitee.page.getByRole('button', { name: 'Continue', exact: true }).click()
  await invitee.page.locator('input[data-input-otp]').fill(signInCode)
  await expect(invitee.page.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await invitee.close()

  await page.reload()
  await expect(page.getByLabel(email, { exact: true })).toHaveCount(0)
  await page.getByRole('radio', { name: 'Accepted' }).click()
  await expect(page.getByLabel(email, { exact: true })).toBeVisible()
})

test('a revoked invitation link is refused', async ({ page, browser, viewport }) => {
  const email = uniqueEmail('revoked')
  await page.goto('/admin/invitations')
  await invite(page, email)
  const inviteUrl = await readInviteUrl(email)

  await page.getByRole('button', { name: `Revoke invitation to ${email}` }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke invitation' }).click()
  await expect(page.getByLabel(email, { exact: true })).toHaveCount(0)
  await page.getByRole('radio', { name: 'Revoked' }).click()
  await expect(page.getByLabel(email, { exact: true })).toBeVisible()

  const invitee = await openSignedOut(browser, viewport)
  await invitee.page.goto(inviteUrl)
  await expect(
    invitee.page.getByRole('heading', { name: 'This invitation is no longer valid', exact: true }),
  ).toBeVisible()
  await invitee.close()
})

test('the Members screen opens the invite form', async ({ page }) => {
  await page.goto('/admin/members')
  await page.getByRole('button', { name: 'Invite member' }).click()

  await expect(page).toHaveURL(/\/admin\/invitations\?edit=new$/)
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible()
})
