/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'

/*
 * The invite-accept screen in SSO mode, with the invitation lookup mocked. An invitee an admin let in
 * past an IdP's domain claim must reach the email code, never SSO. The OIDC e2e backend has no fixed
 * test code, so this stops at the code step; `consumer-invite-accept.spec.ts` finishes a sign-in.
 */
test('in SSO mode an invitation link still takes the email-code path', async ({ page }) => {
  const email = `e2e-invite-${crypto.randomUUID()}@corp.test`
  await page.route('**/v1/invitations/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    }),
  )
  const discoveries: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/sso/discover')) {
      discoveries.push(request.url())
    }
  })

  await page.goto('/invite/e2e-token')

  await expect(page.getByRole('heading', { name: /You've been invited to/ })).toBeVisible()
  await expect(page.getByPlaceholder('Email address', { exact: true })).toHaveValue(email)
  const codeRequested = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/waitlist/join')
  await page.getByRole('button', { name: 'Send Magic Link', exact: true }).click()
  expect((await codeRequested).ok()).toBe(true)

  await expect(page.locator('input[data-input-otp]')).toBeVisible()
  await expect(page).toHaveURL(/\/invite\/e2e-token$/)
  expect(discoveries).toEqual([])
})
