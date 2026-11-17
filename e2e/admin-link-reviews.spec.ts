/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page, type ViewportSize } from '@playwright/test'
import type { AdminConnectionDetail, LinkReview } from '../shared/admin-api'
import { openSidebarOnMobile } from './helpers'
import {
  adminAppUrl,
  type AdminApiRequest,
  adminTest as test,
  routeIdpIdentity,
  uniqueEmail,
  uniqueName,
} from './admin/helpers'

// The env connection's name (backend `ensureEnvSsoConnection`).
const envConnectionName = 'SSO'

type Person = { email: string; envSub: string; heldSub: string }

/** A page in a fresh browser context, signed out, in this project's viewport. */
const visitorPage = async (browser: Browser, viewport: ViewportSize | null) => {
  const context = await browser.newContext({
    baseURL: adminAppUrl,
    viewport,
    storageState: { cookies: [], origins: [] },
  })
  return context.newPage()
}

/** Sign in from the login screen through the named connection. The org has several, so it asks for the email first. */
const signInThrough = async (page: Page, connectionName: string, identity: { sub: string; email: string }) => {
  await routeIdpIdentity(page, identity)
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Work email' }).fill(identity.email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: connectionName, exact: true }).click()
}

/**
 * Hold a link: the person signs in through the env connection first, then through `connection` with
 * the same email and another subject, which an admin has to approve.
 */
const holdLink = async (browser: Browser, viewport: ViewportSize | null, connection: AdminConnectionDetail) => {
  const person: Person = { email: uniqueEmail('held'), envSub: crypto.randomUUID(), heldSub: crypto.randomUUID() }
  const first = await visitorPage(browser, viewport)
  await signInThrough(first, envConnectionName, { sub: person.envSub, email: person.email })
  await expect(first.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await first.context().close()

  await expectRefused(browser, viewport, connection, person)
  return person
}

/** The person's sign-in through `connection` is refused while the link waits. */
const expectRefused = async (
  browser: Browser,
  viewport: ViewportSize | null,
  connection: AdminConnectionDetail,
  person: Person,
) => {
  const page = await visitorPage(browser, viewport)
  await signInThrough(page, connection.name, { sub: person.heldSub, email: person.email })
  await expect(page).toHaveURL(/\/sso-error\?error=LINK_REVIEW_PENDING/)
  await expect(page.getByText(/already uses this email/)).toBeVisible()
  await page.context().close()
}

const reviewsOn = (adminApi: AdminApiRequest, connectionId: string, status: string) =>
  adminApi.request<{ reviews: LinkReview[] }>('GET', `admin/link-reviews?status=${status}&connectionId=${connectionId}`)

/** Open the person's review from the queue, under `status`. */
const openReview = async (page: Page, email: string, status = 'Pending') => {
  await page.goto('/admin/link-reviews')
  await page.getByRole('radio', { name: status }).click()
  await page.getByRole('button', { name: email, exact: true }).click()
}

const decide = async (page: Page, decision: 'Approve' | 'Reject') => {
  await page.getByRole('button', { name: decision, exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: decision, exact: true }).click()
  await expect(dialog).toBeHidden()
}

let connections: AdminConnectionDetail[] = []

test.beforeEach(async ({ adminApi }) => {
  connections = [await adminApi.seedOidcConnection({ name: uniqueName('Held link') })]
})

test.afterEach(async ({ adminApi }) => {
  for (const connection of connections) {
    await adminApi.request('POST', `admin/connections/${connection.id}/retire`)
  }
})

test('a held SSO link waits in the queue, and approving it lets the person sign in linked', async ({
  page,
  browser,
  viewport,
  adminApi,
}) => {
  const [connection] = connections
  const person = await holdLink(browser, viewport, connection)

  await page.goto('/admin/audit-log')
  await openSidebarOnMobile(page)
  const navItem = page.locator('[data-sidebar="menu-item"]', { hasText: 'Link reviews' })
  await expect(navItem.locator('[data-sidebar="menu-badge"]')).toHaveText(/^\d+\+?$/)
  await navItem.locator('[data-sidebar="menu-button"]').click()

  await openReview(page, person.email)
  const incoming = page.getByRole('region', { name: 'Incoming identity' })
  await expect(incoming.getByText(connection.name)).toBeVisible()
  await expect(incoming.getByText('SSO sign-in')).toBeVisible()
  await expect(incoming.getByText(person.heldSub)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Existing account' }).getByText(person.email)).toBeVisible()
  await decide(page, 'Approve')

  await expect(page.getByRole('button', { name: person.email, exact: true })).toBeHidden()
  await page.getByRole('radio', { name: 'Approved' }).click()
  await expect(page.getByRole('button', { name: person.email, exact: true })).toBeVisible()

  const linked = await visitorPage(browser, viewport)
  await signInThrough(linked, connection.name, { sub: person.heldSub, email: person.email })
  await expect(linked.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await linked.context().close()
  const { reviews } = await reviewsOn(adminApi, connection.id, 'linked')
  expect(reviews.map((review) => review.incomingEmail)).toContain(person.email)
})

test('rejecting a held link keeps the person refused, and leaves it to approve later', async ({
  page,
  browser,
  viewport,
}) => {
  const [connection] = connections
  const person = await holdLink(browser, viewport, connection)

  await openReview(page, person.email)
  await decide(page, 'Reject')

  await expectRefused(browser, viewport, connection, person)
  await openReview(page, person.email, 'Rejected')
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0)
})
