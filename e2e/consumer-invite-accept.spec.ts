/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from './test'
import { collectPageErrors } from './helpers'

/*
 * The invite-accept screen, with the invitation lookup mocked: nothing in this backend can create an
 * invitation yet. This spec does NOT prove invitation admission. The sign-in below succeeds because
 * the e2e backend auto-approves `thunderbolt.test` on the waitlist, so the waitlist rule admits the
 * address, not the invitation rule. Invitation admission is covered by the backend integration tests;
 * the end-to-end flow, where an admin invites and the recipient accepts, comes with the admin API.
 */

const mockInvitation = async (page: Page, response: { status: number; body: unknown }) => {
  await page.route('**/v1/invitations/*', (route) =>
    route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) }),
  )
}

test('an invitation link offers the email code for the invited address and signs in', async ({ page }) => {
  const errors = collectPageErrors(page)
  const email = `e2e-invite-${crypto.randomUUID()}@thunderbolt.test`
  await mockInvitation(page, {
    status: 200,
    body: { email, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  })

  await page.goto('/invite/e2e-token')

  await expect(page.getByRole('heading', { name: /You've been invited to/ })).toBeVisible()
  await expect(page.getByText(`Sign in with ${email} to accept the invitation.`, { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('Email', { exact: true })).toHaveValue(email)
  const codeRequested = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/waitlist/join')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  expect((await codeRequested).ok()).toBe(true)
  // A complete code verifies on its own, and a successful sign-in goes straight into the app.
  await page.locator('input[data-input-otp]').fill('12345678')

  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})

test('an invitation that can no longer be used says so and offers sign-in', async ({ page }) => {
  await mockInvitation(page, { status: 404, body: { code: 'INVITATION_NOT_FOUND' } })

  await page.goto('/invite/e2e-token')

  await expect(page.getByRole('heading', { name: 'This invitation is no longer valid', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(page.getByPlaceholder('Email', { exact: true })).toBeVisible()
})
