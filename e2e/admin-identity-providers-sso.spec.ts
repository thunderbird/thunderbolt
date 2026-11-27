/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'
import type { Page as ApiPage, AdminMember } from '../shared/admin-api'
import {
  type AdminApiRequest,
  adminIdpUrls,
  adminTest as test,
  choosePanelAction,
  openAdminRow,
  panelMenu,
  retireConnection,
  signInThroughConnection,
  uniqueEmail,
  uniqueName,
  closePanel,
} from './admin/helpers'
import { adminSpareIdpSecretPrefix } from './admin/mock-idp'

const seeded: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seeded.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

const openConnection = async (page: Page, adminApi: AdminApiRequest, connectionId: string) => {
  const { name } = await adminApi.request<{ name: string }>('GET', `admin/connections/${connectionId}`)
  await openAdminRow(page, '/admin/sign-in-methods', name)
  await expect(page.getByRole('radio', { name: 'Sign-in' })).toBeVisible()
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

  await page.goto('/admin/sign-in-methods')
  await page.getByRole('button', { name: 'New Sign-in Method' }).click()
  await page.getByRole('button', { name: /^OIDC single sign-on/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('combobox', { name: 'Identity provider' }).click()
  await page.getByRole('option', { name: 'Keycloak' }).click()
  await page.getByLabel('Provider ID').fill(providerId)
  await expect(page.getByRole('textbox', { name: 'Redirect URI' })).toHaveValue(
    new RegExp(`/v1/api/auth/sso/callback/${providerId}$`),
  )
  await page.getByLabel('Issuer').fill(adminIdpUrls.spare)
  await page.getByLabel('Client ID').fill('thunderbolt-admin-e2e')
  await page.getByLabel('Client secret').fill(`${adminSpareIdpSecretPrefix}first`)
  await expect(page.getByLabel('Match claim')).toHaveValue('sub')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(page.getByText('thunderbolt-admin-e2e', { exact: true })).toBeVisible()
  const connectionId = await adminApi.connectionIdByName(name)
  seeded.push(connectionId)
  await expect(page.getByRole('textbox', { name: 'Redirect URI' })).toHaveValue(
    new RegExp(`/v1/api/auth/sso/callback/${providerId}$`),
  )

  const identity = { sub: `e2e-sub-${crypto.randomUUID()}`, email: uniqueEmail('sso') }
  const first = await signInThroughConnection(browser, viewport, name, identity)
  await expect(first.page).toHaveURL(/\/chats\//)
  await first.close()

  // The admin replaces the secret in the edit form; the same person signs in again, with no relink.
  await openConnection(page, adminApi, connectionId)
  await choosePanelAction(page, 'Edit')
  await page.getByLabel('New client secret').fill(`${adminSpareIdpSecretPrefix}second`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit Connection' })).toHaveCount(0)

  const second = await signInThroughConnection(browser, viewport, name, identity)
  await expect(second.page).toHaveURL(/\/chats\//)
  await second.close()
  expect(await membersWithEmail(adminApi, identity.email)).toHaveLength(1)

  // Control: a secret the IdP refuses breaks sign-in, so the saved secret is the one in use.
  await adminApi.request('PATCH', `admin/connections/${connectionId}`, { oidc: { clientSecret: 'e2e-wrong' } })
  const refused = await signInThroughConnection(browser, viewport, name, identity)
  await expect(refused.page).toHaveURL(/\/sso-error/)
  await refused.close()

  // Someone has signed in, so the edit form shows the identity fields locked before any edit.
  await openConnection(page, adminApi, connectionId)
  await choosePanelAction(page, 'Edit')
  await expect(page.getByLabel('Client ID')).toBeDisabled()
  await expect(page.getByLabel('Client ID')).toHaveAccessibleDescription('Locked after the first sign-in.')
  await expect(page.getByLabel('Match claim')).toBeDisabled()
  await expect(page.getByLabel('New client secret')).toBeEditable()
})

test('an admin retires an SSO connection after confirming', async ({ page, adminApi }) => {
  const connection = await adminApi.seedOidcConnection()
  seeded.push(connection.id)

  await openConnection(page, adminApi, connection.id)
  await choosePanelAction(page, 'Retire')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Retire connection' }).click()

  // Retired: the panel stays open to show it, and the row moves under the list's Retired label.
  await closePanel(page)
  await expect(page.getByRole('heading', { name: 'Retired', exact: true })).toBeVisible()
  await expect
    .poll(async () => (await adminApi.request<{ status: string }>('GET', `admin/connections/${connection.id}`)).status)
    .toBe('retired')
})

test("the server's own SSO connection is read-only", async ({ page, adminApi }) => {
  await openConnection(page, adminApi, 'sso')
  await expect(page.getByText('Set by server settings · Read-only', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(panelMenu(page)).toHaveCount(0)
})
