/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page, type ViewportSize } from '@playwright/test'
import type { AdminConnectionDetail, Page as ApiPage, AdminMember } from '../shared/admin-api'
import {
  adminAppUrl,
  adminIdpUrls,
  adminTest as test,
  routeIdpIdentity,
  uniqueEmail,
  uniqueName,
  type AdminApiRequest,
} from './admin/helpers'
import { adminSpareIdpSecretPrefix } from './admin/mock-idp'

const seeded: string[] = []

/** Retire what a test created, SCIM side first, so the shared org keeps only live connections. */
const retireConnection = async (adminApi: AdminApiRequest, connectionId: string) => {
  const detail = await adminApi.request<AdminConnectionDetail>('GET', `admin/connections/${connectionId}`)
  if (detail.status === 'active' && detail.scim) {
    await adminApi.request('POST', `admin/connections/${connectionId}/scim/retire`)
  }
  if (!detail.sso || detail.status === 'retired') {
    return
  }
  await expect
    .poll(
      async () => (await adminApi.request<AdminConnectionDetail>('GET', `admin/connections/${connectionId}`)).status,
    )
    .not.toBe('scim_retiring')
  await adminApi.request('POST', `admin/connections/${connectionId}/retire`)
}

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seeded.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

const openConnection = async (page: Page, connectionId: string) => {
  await page.goto(`/admin/identity-providers?edit=${connectionId}`)
  await expect(page.getByRole('radio', { name: 'Sign-in' })).toBeVisible()
}

/** A fresh browser signs in through `connectionName` as `identity`; resolves to where it landed. */
const signInThroughConnection = async (
  browser: Browser,
  viewport: ViewportSize | null,
  connectionName: string,
  identity: { sub: string; email: string },
) => {
  const context = await browser.newContext({
    baseURL: adminAppUrl,
    viewport,
    storageState: { cookies: [], origins: [] },
  })
  const page = await context.newPage()
  await routeIdpIdentity(page, identity)
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Work email' }).fill(identity.email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: connectionName, exact: true }).click()
  await page.waitForURL(/\/(chats|sso-error)/, { timeout: 30_000 })
  return { page, close: () => context.close() }
}

const membersWithEmail = async (adminApi: AdminApiRequest, email: string) =>
  (await adminApi.request<ApiPage<AdminMember>>('GET', `admin/members?q=${encodeURIComponent(email)}`)).items.filter(
    (member) => member.email === email,
  )

test('an admin adds an OIDC connection, people sign in through it, and a new secret keeps sign-in working', async ({
  page,
  browser,
  viewport,
  adminApi,
}) => {
  const name = uniqueName('Keycloak')
  const providerId = `e2e-${crypto.randomUUID().slice(0, 8)}`

  await page.goto('/admin/identity-providers')
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByRole('button', { name: 'Single sign-on with OIDC' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('combobox', { name: 'Identity provider' }).click()
  await page.getByRole('option', { name: 'Keycloak' }).click()
  await page.getByLabel('Provider ID').fill(providerId)
  await expect(page.getByText(`/v1/api/auth/sso/callback/${providerId}`)).toBeVisible()
  await page.getByLabel('Issuer').fill(adminIdpUrls.spare)
  await page.getByLabel('Client ID').fill('thunderbolt-admin-e2e')
  await page.getByLabel('Client secret').fill(`${adminSpareIdpSecretPrefix}first`)
  await expect(page.getByLabel('Match claim')).toHaveValue('sub')
  await page.getByRole('button', { name: 'Create connection' }).click()

  await expect(page).toHaveURL(/edit=(?!new\b)/)
  const connectionId = new URL(page.url()).searchParams.get('edit')!
  seeded.push(connectionId)
  await expect(page.getByLabel('Client ID')).toHaveValue('thunderbolt-admin-e2e')
  await expect(page.getByText(`/v1/api/auth/sso/callback/${providerId}`)).toBeVisible()

  const identity = { sub: `e2e-sub-${crypto.randomUUID()}`, email: uniqueEmail('sso') }
  const first = await signInThroughConnection(browser, viewport, name, identity)
  await expect(first.page).toHaveURL(/\/chats\//)
  await first.close()

  // The admin replaces the secret in the panel; the same person signs in again, with no relink.
  await openConnection(page, connectionId)
  await page.getByLabel('New client secret').fill(`${adminSpareIdpSecretPrefix}second`)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()

  const second = await signInThroughConnection(browser, viewport, name, identity)
  await expect(second.page).toHaveURL(/\/chats\//)
  await second.close()
  expect(await membersWithEmail(adminApi, identity.email)).toHaveLength(1)

  // Control: a secret the IdP refuses breaks sign-in, so the saved secret is the one in use.
  await adminApi.request('PATCH', `admin/connections/${connectionId}`, { oidc: { clientSecret: 'e2e-wrong' } })
  const refused = await signInThroughConnection(browser, viewport, name, identity)
  await expect(refused.page).toHaveURL(/\/sso-error/)
  await refused.close()

  // Someone has signed in, so the panel shows the identity fields locked before any edit.
  await openConnection(page, connectionId)
  await expect(page.getByLabel('Client ID')).toHaveAttribute('readonly', '')
  await expect(page.getByLabel('Client ID')).toHaveAccessibleDescription(/Locked because people have signed in/)
  await expect(page.getByLabel('Match claim')).toHaveAttribute('readonly', '')
  await expect(page.getByLabel('New client secret')).toBeEditable()
})

test('an admin retires an SSO connection after confirming', async ({ page, adminApi }) => {
  const connection = await adminApi.seedOidcConnection()
  seeded.push(connection.id)

  await openConnection(page, connection.id)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Retire connection' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Retire connection' }).click()

  await expect(page.getByRole('button', { name: connection.name })).toContainText('Retired')
})

test("the server's own SSO connection is read-only", async ({ page }) => {
  await openConnection(page, 'sso')
  await expect(page.getByText("Set by this server's OIDC or SAML settings. Change them there.")).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0)
})
