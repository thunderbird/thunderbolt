/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page, type ViewportSize } from '@playwright/test'
import type { AdminConnectionDetail, LinkReview } from '../shared/admin-api'
import { openSidebarOnMobile } from './helpers'
import {
  type AdminApiRequest,
  adminAppUrl,
  adminTest as test,
  retireConnection,
  routeIdpIdentity,
  searchMembers,
  uniqueEmail,
  uniqueName,
  choosePanelAction,
  panelMenu,
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

/** The person's link review row on Members, where rejected ones are listed too, dimmed, at the end. */
const reviewRow = (page: Page, email: string) =>
  page.getByRole('button', { name: `Open link review for ${email}`, exact: true })

/** Open the person's review on Members, searched by email: other workers share the org. */
const openReview = async (page: Page, email: string) => {
  await searchMembers(page, email)
  await reviewRow(page, email).click()
}

/** Decide the open review from its ⋯ menu, through the confirm. */
const decide = async (page: Page, decision: 'Approve' | 'Reject') => {
  await choosePanelAction(page, decision)
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
    await retireConnection(adminApi, connection.id)
  }
})

test('a held SSO link waits above Members, and approving it lets the person sign in linked', async ({
  page,
  browser,
  viewport,
  adminApi,
}) => {
  const [connection] = connections
  const person = await holdLink(browser, viewport, connection)

  await page.goto('/admin/audit-log')
  await openSidebarOnMobile(page)
  const navItem = page.locator('[data-sidebar="menu-item"]', { hasText: 'Members' })
  await expect(navItem.locator('[data-sidebar="menu-badge"]')).toHaveText(/^\d+\+?$/)

  await page.goto('/admin/members')
  await expect(reviewRow(page, person.email)).toContainText('Review pending')
  await openReview(page, person.email)
  const panel = page.getByRole('complementary').or(page.getByRole('dialog'))
  await expect(panel.getByText(connection.name, { exact: true })).toBeVisible()
  await expect(panel.getByText('SSO sign-in', { exact: true })).toBeVisible()
  await expect(panel.getByText(person.heldSub, { exact: true })).toBeVisible()
  await expect(panel.getByText('Existing account', { exact: true })).toBeVisible()
  await decide(page, 'Approve')

  await expect(page.getByRole('heading', { name: person.email, exact: true })).toBeHidden()
  // The search still holds the email, so the person's member row is what the list shows now.
  await expect(page.getByText(person.email, { exact: true }).first()).toBeVisible()
  await expect(reviewRow(page, person.email)).toHaveCount(0)

  const linked = await visitorPage(browser, viewport)
  await signInThrough(linked, connection.name, { sub: person.heldSub, email: person.email })
  await expect(linked.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await linked.context().close()
  const { reviews } = await reviewsOn(adminApi, connection.id, 'linked')
  expect(reviews.map((review) => review.incomingEmail)).toContain(person.email)
})

test('rejecting a held link keeps the person refused, and the rejected link can still be approved', async ({
  page,
  browser,
  viewport,
}) => {
  const [connection] = connections
  const person = await holdLink(browser, viewport, connection)

  await openReview(page, person.email)
  await decide(page, 'Reject')

  await expectRefused(browser, viewport, connection, person)
  // Checked before opening: on narrow screens the panel covers the list.
  await searchMembers(page, person.email)
  await expect(reviewRow(page, person.email)).toContainText('Rejected')
  await reviewRow(page, person.email).click()
  await panelMenu(page).click()
  await expect(page.getByRole('menuitem', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Reject', exact: true })).toHaveCount(0)
})
