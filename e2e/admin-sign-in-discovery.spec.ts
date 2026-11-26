/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page, type ViewportSize } from '@playwright/test'
import type { OrgDomain } from '../shared/admin-api'
import {
  type AdminApiRequest,
  adminAppUrl,
  adminTest as test,
  openAdminRow,
  publishTxtRecord,
  retireConnection,
  routeIdpIdentity,
} from './admin/helpers'

/*
 * The login screen's discovery: an email on a domain an identity provider claims goes straight to
 * that provider, and any other email is offered a choice. Every worker's connections are live in the
 * shared org, so these assert on the connections each test seeded, never on the whole list.
 */

/** The org domain `domainId`, as the admin list has it. */
const findDomain = async (adminApi: AdminApiRequest, domainId: string) =>
  (await adminApi.request<{ items: OrgDomain[] }>('GET', 'admin/domains')).items.find((item) => item.id === domainId)

const seededConnections: string[] = []
const seededDomains: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const domainId of seededDomains.splice(0)) {
    const domain = await findDomain(adminApi, domainId)
    if (domain?.claimedBy) {
      await adminApi.request('DELETE', `admin/domains/${domainId}/claim`)
    }
    await adminApi.request('DELETE', `admin/domains/${domainId}`)
  }
  for (const connectionId of seededConnections.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

/** A signed-out page on the sign-in screen, with its IdP sign-in arriving as `email`. */
const openSignIn = async (browser: Browser, viewport: ViewportSize | null, email: string) => {
  const context = await browser.newContext({
    baseURL: adminAppUrl,
    viewport,
    storageState: { cookies: [], origins: [] },
  })
  const page = await context.newPage()
  await routeIdpIdentity(page, { sub: `e2e-sub-${crypto.randomUUID()}`, email })
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Work email' }).fill(email)
  return { page, close: () => context.close() }
}

/**
 * Click Continue and resolve to what discovery answered for `email`. The screen also asks once on
 * mount, without an email; only the call that carries it decides.
 */
const continueAndDiscover = async (page: Page, email: string) => {
  const discovered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/sso/discover' &&
      (response.request().postDataJSON() as { email?: string } | null)?.email === email,
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const { connections } = (await (await discovered).json()) as { connections: { providerId: string }[] }
  return connections.map((connection) => connection.providerId)
}

/** Resolves to the provider id the next SSO sign-in on `page` starts with. */
const nextSsoSignIn = (page: Page) =>
  page
    .waitForRequest((request) => new URL(request.url()).pathname === '/v1/api/auth/sign-in/sso')
    .then((request) => (request.postDataJSON() as { providerId: string }).providerId)

test('an email on a claimed domain goes straight to the connection that claims it', async ({
  page,
  browser,
  viewport,
  adminApi,
  request,
}) => {
  test.slow()
  const other = await adminApi.seedOidcConnection()
  const claimant = await adminApi.seedOidcConnection()
  seededConnections.push(other.id, claimant.id)
  const domainName = `e2e-${crypto.randomUUID().slice(0, 8)}.test`
  const domain = await adminApi.request<OrgDomain>('POST', 'admin/domains', { domain: domainName })
  seededDomains.push(domain.id)
  await publishTxtRecord(request, domain.record)

  // The admin verifies the domain through DNS, then claims it for one connection.
  await openAdminRow(page, '/admin/sign-in-methods', domainName)
  const claimPicker = page.getByRole('combobox', { name: 'Identity provider' })
  await expect(claimPicker).toBeDisabled()
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(claimPicker).toBeEnabled()
  await claimPicker.click()
  // Each option names the connection, then the sides it has.
  await page.getByRole('option', { name: `${claimant.name} SSO`, exact: true }).click()
  await page.getByRole('button', { name: 'Claim', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Release claim' })).toBeVisible()
  expect(await findDomain(adminApi, domain.id)).toMatchObject({
    verifiedAt: expect.any(String),
    claimedBy: { id: claimant.id },
  })

  const email = `member-${crypto.randomUUID().slice(0, 8)}@${domainName}`
  const signIn = await openSignIn(browser, viewport, email)
  const startedWith = nextSsoSignIn(signIn.page)
  expect(await continueAndDiscover(signIn.page, email)).toEqual([claimant.sso!.providerId])
  expect(await startedWith).toBe(claimant.sso!.providerId)
  await expect(signIn.page).toHaveURL(/\/chats\//, { timeout: 30_000 })
  await signIn.close()
})

test('an email no claim matches is offered every connection, and signs in through the one picked', async ({
  browser,
  viewport,
  adminApi,
}) => {
  const first = await adminApi.seedOidcConnection()
  const second = await adminApi.seedOidcConnection()
  seededConnections.push(first.id, second.id)

  const email = `member-${crypto.randomUUID().slice(0, 8)}@unclaimed-${crypto.randomUUID().slice(0, 8)}.test`
  const signIn = await openSignIn(browser, viewport, email)
  const offered = await continueAndDiscover(signIn.page, email)
  expect(offered).toEqual(expect.arrayContaining([first.sso!.providerId, second.sso!.providerId]))

  await expect(signIn.page.getByRole('heading', { name: 'Choose how to sign in' })).toBeVisible()
  await expect(signIn.page.getByRole('button', { name: first.name, exact: true })).toBeVisible()
  const startedWith = nextSsoSignIn(signIn.page)
  await signIn.page.getByRole('button', { name: second.name, exact: true }).click()
  expect(await startedWith).toBe(second.sso!.providerId)
  await expect(signIn.page).toHaveURL(/\/chats\//, { timeout: 30_000 })
  await signIn.close()
})
