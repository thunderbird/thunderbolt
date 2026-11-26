/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'
import {
  adminAppUrl,
  adminTest as test,
  canaryStatus,
  canSignIn,
  createScimClient,
  e2eSignInCode,
  openMember,
  otpCooldownMs,
  requestEmailCodeSignIn,
  retireConnection,
  signInByEmailCode,
  signInThroughConnection,
  uniqueEmail,
} from './admin/helpers'

const seeded: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seeded.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

/**
 * Ask for an email code on the fallback page and enter it, waiting out the code cooldown once.
 * Resolves to the error code the sign-in answered with, or null when it signed in.
 */
const submitEmailCode = async (page: Page, email: string) => {
  await page.goto('/sign-in/email-code')
  await page.getByPlaceholder('Email', { exact: true }).fill(email)
  const requestCode = async () => {
    const response = page.waitForResponse((res) => new URL(res.url()).pathname === '/v1/waitlist/join')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    return (await response).status()
  }
  if ((await requestCode()) === 429) {
    await page.waitForTimeout(otpCooldownMs)
    expect(await requestCode()).toBe(200)
  }
  const codeInput = page.locator('input[autocomplete="one-time-code"]')
  await expect(codeInput).toBeVisible()
  const signIn = page.waitForResponse((res) => new URL(res.url()).pathname === '/v1/api/auth/sign-in/email-otp')
  await codeInput.fill(e2eSignInCode)
  const response = await signIn
  return response.ok() ? null : ((await response.json()) as { code?: string }).code
}

test('SCIM active:false refuses the next request and sign-in, and active:true restores them', async ({
  page,
  adminApi,
  request,
}) => {
  test.slow()
  const { connection, token } = await adminApi.seedScimConnection()
  seeded.push(connection.id)
  const scim = createScimClient(request, token)
  const email = uniqueEmail('scim')
  const scimId = await scim.createUser(email)

  // A SCIM-only connection has no sign-in of its own, so its member signs in by email code.
  const signIn = await requestEmailCodeSignIn(request, email)
  expect(signIn.ok()).toBe(true)
  const memberToken = signIn.headers()['set-auth-token']
  expect(await canaryStatus(request, memberToken)).not.toBe(401)

  await scim.setActive(scimId, false)
  expect(await canaryStatus(request, memberToken)).toBe(401)
  expect(await canSignIn(request, email)).toBe(false)
  await openMember(page, email)
  await expect(page.getByText('Removed by the identity provider')).toBeVisible()

  // Deactivation ended the old session, so reactivating lets the member sign in again rather than
  // reviving it.
  await scim.setActive(scimId, true)
  expect(await canaryStatus(request, memberToken)).toBe(401)
  expect(await canSignIn(request, email)).toBe(true)
  await openMember(page, email)
  await expect(page.getByText('Can sign in')).toBeVisible()
})

test('a SCIM-only member signs in by email code, and an SSO side makes them sign in through SSO', async ({
  browser,
  viewport,
  adminApi,
  request,
}) => {
  test.slow()
  const { connection, token } = await adminApi.seedScimConnection()
  seeded.push(connection.id)
  const email = uniqueEmail('scim')
  const externalId = crypto.randomUUID()
  await createScimClient(request, token).createUser(email, externalId)

  const freshPage = async () => {
    const context = await browser.newContext({
      baseURL: adminAppUrl,
      viewport,
      storageState: { cookies: [], origins: [] },
    })
    return { page: await context.newPage(), close: () => context.close() }
  }

  const before = await freshPage()
  await signInByEmailCode(before.page, email)
  await before.close()

  const withSso = await adminApi.seedOidcConnection({ identityConnectionId: connection.id })

  const refused = await freshPage()
  expect(await submitEmailCode(refused.page, email)).toBe('ACCESS_SSO_REQUIRED')
  await expect(
    refused.page.getByText('Your organization requires you to sign in with single sign-on.', { exact: true }),
  ).toBeVisible()
  await refused.close()

  // The SSO side matches the SCIM record on `sub`, its externalId.
  const viaSso = await signInThroughConnection(browser, viewport, withSso.name, { sub: externalId, email })
  await expect(viaSso.page).toHaveURL(/\/chats\//)
  await viaSso.close()
  expect((await adminApi.findMember(email)).email).toBe(email)
})
