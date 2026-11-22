/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { scimBasePath, type AdminConnectionDetail } from '../shared/admin-api'
import {
  adminApiBaseUrl,
  adminIdpUrls,
  adminTest as test,
  pickDate,
  retireConnection,
  uniqueEmail,
  uniqueName,
} from './admin/helpers'
import { adminSpareIdpSecretPrefix } from './admin/mock-idp'

const scimUserSchema = 'urn:ietf:params:scim:schemas:core:2.0:User'
const scimGroupSchema = 'urn:ietf:params:scim:schemas:core:2.0:Group'

/** A SCIM request as the identity provider makes it. */
const scim = (request: APIRequestContext, token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  request.fetch(`${adminApiBaseUrl}${scimBasePath}${path}`, {
    method,
    data: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' },
  })

const listUsersStatus = async (request: APIRequestContext, token: string) =>
  (await scim(request, token, 'GET', '/Users?count=1')).status()

const seeded: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seeded.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

const openConnection = async (page: Page, connectionId: string, section: string) => {
  await page.goto(`/admin/identity-providers?edit=${connectionId}`)
  await page.getByRole('radio', { name: section }).click()
}

const readToken = (page: Page) => page.getByRole('textbox', { name: 'SCIM token' }).inputValue()

/** A day `days` from today, and the expiry the server should store for it (the end of that local day). */
const dateInDays = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
  return { date, expiresAt: end.toISOString(), year: String(date.getFullYear()) }
}

test('a SCIM token works until its credential is revoked', async ({ page, request, adminApi }) => {
  await page.goto('/admin/identity-providers')
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByRole('button', { name: 'SCIM provisioning only' }).click()
  await page.getByLabel('Name', { exact: true }).fill(uniqueName('SCIM'))
  await page.getByRole('button', { name: 'Create connection' }).click()

  const firstToken = await readToken(page)
  await expect(page.getByRole('textbox', { name: 'SCIM base URL' })).toHaveValue(`${adminApiBaseUrl}${scimBasePath}`)
  expect(await listUsersStatus(request, firstToken)).toBe(200)
  await page.getByRole('button', { name: 'Done' }).click()

  await expect(page).toHaveURL(/edit=(?!new\b)/)
  const connectionId = new URL(page.url()).searchParams.get('edit')!
  seeded.push(connectionId)

  // A second credential, with a chosen expiry, works alongside the first.
  await page.getByRole('radio', { name: 'Provisioning' }).click()
  const expiry = dateInDays(30)
  await pickDate(page, 'Credential expires on', expiry.date)
  await page.getByRole('button', { name: 'Issue a new credential' }).click()
  const secondToken = await readToken(page)
  expect(secondToken).not.toBe(firstToken)
  expect(await listUsersStatus(request, secondToken)).toBe(200)
  await page.getByRole('button', { name: 'Done' }).click()

  const { scimCredentials } = await adminApi.request<AdminConnectionDetail>('GET', `admin/connections/${connectionId}`)
  const [oldest, newest] = [...scimCredentials].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  expect(newest.expiresAt).toBe(expiry.expiresAt)
  await expect(page.getByRole('listitem', { name: `Credential ${newest.credentialId.slice(-8)}` })).toContainText(
    expiry.year,
  )

  await page.getByRole('button', { name: `Revoke credential ${oldest.credentialId.slice(-8)}` }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByRole('listitem', { name: `Credential ${oldest.credentialId.slice(-8)}` })).toContainText(
    'Revoked',
  )
  expect(await listUsersStatus(request, firstToken)).toBe(401)
  expect(await listUsersStatus(request, secondToken)).toBe(200)
})

test("a rejected SCIM request shows under the connection's sync errors", async ({ page, request, adminApi }) => {
  const { connection, token } = await adminApi.seedScimConnection()
  seeded.push(connection.id)

  const rejected = await scim(request, token, 'POST', '/Users', {
    schemas: [scimUserSchema],
    userName: uniqueEmail('no-external-id'),
    active: true,
  })
  expect(rejected.status()).toBeGreaterThanOrEqual(400)

  await openConnection(page, connection.id, 'Sync errors')
  await expect(page.getByText(`POST Users → ${rejected.status()}`)).toBeVisible()
})

test('mapping a SCIM group to admin makes its members admin', async ({ page, request, adminApi }) => {
  const { connection, token } = await adminApi.seedScimConnection()
  seeded.push(connection.id)

  const email = uniqueEmail('scim')
  const user = await scim(request, token, 'POST', '/Users', {
    schemas: [scimUserSchema],
    externalId: crypto.randomUUID(),
    userName: email,
    emails: [{ value: email, type: 'work', primary: true }],
    name: { givenName: 'Grace', familyName: 'Hopper' },
    active: true,
  })
  expect(user.status()).toBe(201)
  const displayName = uniqueName('Admins')
  const group = await scim(request, token, 'POST', '/Groups', {
    schemas: [scimGroupSchema],
    displayName,
    members: [{ value: ((await user.json()) as { id: string }).id }],
  })
  expect(group.status()).toBe(201)

  const scimAdminRole = async () =>
    (await adminApi.findMember(email)).roles.some((source) => source.role === 'admin' && source.from === 'scim')

  await openConnection(page, connection.id, 'Groups')
  const row = page.getByRole('listitem', { name: displayName })
  await expect(row).toContainText('1 member')
  const toggle = row.getByRole('switch', { name: `Make members of ${displayName} admins` })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(scimAdminRole).toBe(true)

  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(scimAdminRole).toBe(false)
})

test('an SSO connection takes SCIM, and a SCIM connection takes SSO', async ({ page, adminApi }) => {
  const sso = await adminApi.seedOidcConnection()
  seeded.push(sso.id)
  await openConnection(page, sso.id, 'Provisioning')
  await expect(page.getByText(/makes sign-in through this connection SSO-only/)).toBeVisible()
  await page.getByRole('button', { name: 'Turn on SCIM' }).click()
  await expect(page.getByRole('textbox', { name: 'SCIM token' })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Retire SCIM' })).toBeVisible()

  const { connection } = await adminApi.seedScimConnection()
  seeded.push(connection.id)
  await openConnection(page, connection.id, 'Sign-in')
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Add OIDC sign-in' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0)
  await page.getByLabel('Provider ID').fill(`e2e-${crypto.randomUUID().slice(0, 8)}`)
  await page.getByLabel('Issuer').fill(adminIdpUrls.spare)
  await page.getByLabel('Client ID').fill('thunderbolt-admin-e2e')
  await page.getByLabel('Client secret').fill(`${adminSpareIdpSecretPrefix}attach`)
  await page.getByRole('button', { name: 'Add single sign-on' }).click()

  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(connection.name)
  const attached = await adminApi.request<AdminConnectionDetail>('GET', `admin/connections/${connection.id}`)
  expect(attached).toMatchObject({
    name: connection.name,
    sso: { protocol: 'oidc' },
    scim: { scimConnectionId: expect.any(String) },
  })
})

test('retiring SCIM shows it in progress, then retired, and its token stops working', async ({
  page,
  request,
  adminApi,
}) => {
  const { connection, token } = await adminApi.seedScimConnection()
  seeded.push(connection.id)
  expect(await listUsersStatus(request, token)).toBe(200)

  await openConnection(page, connection.id, 'Provisioning')
  await page.getByRole('button', { name: 'Retire SCIM' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Retire SCIM' }).click()

  await expect(
    page.getByRole('status').filter({ hasText: /Retiring SCIM provisioning|SCIM provisioning is retired/ }),
  ).toBeVisible()
  await expect(page.getByText('SCIM provisioning is retired.')).toBeVisible({ timeout: 30_000 })
  expect(await listUsersStatus(request, token)).toBe(401)
})
