/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import { scimBasePath, type BreakGlassStatus, type LinkReviewPage } from '../shared/admin-api'
import {
  adminApiBaseUrl,
  adminAppUrl,
  adminRouteStatus,
  adminTest as test,
  canaryStatus,
  canSignIn,
  choosePanelAction,
  openMember,
  panelMenu,
  retireConnection,
  uniqueName,
} from './admin/helpers'

const seededConnections: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seededConnections.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

test('an admin finds a member by search and renames them', async ({ page, adminApi }) => {
  const member = await adminApi.seedMember()
  const name = uniqueName('Renamed')

  // Search finds them; openMember searches Members by email.
  await openMember(page, member.email)

  await choosePanelAction(page, 'Edit')
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
})

test("a local admin's panel gives the email-code sign-in address, with no warning on Members", async ({
  page,
  adminApi,
  adminSession,
}) => {
  // Bootstrap admins sign in by email code, so the org always has an admin who doesn't need the IdP here.
  const status = await adminApi.request<BreakGlassStatus>('GET', 'admin/break-glass')
  expect(status.allAdminsIdpManaged).toBe(false)

  await openMember(page, adminSession.email)

  await expect(page.getByText('Can sign in without your identity provider', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Email-code sign-in address' })).toHaveValue(
    `${adminAppUrl}/sign-in/email-code`,
  )
  await expect(page.getByText('No admin can sign in without your identity provider')).toHaveCount(0)
})

test('blocking a member refuses their next request, and unblocking lets them sign in again', async ({
  page,
  adminApi,
  request,
}) => {
  test.slow()
  const member = await adminApi.seedMember()
  expect(await canaryStatus(request, member.token)).not.toBe(401)

  await openMember(page, member.email)
  await choosePanelAction(page, 'Block')
  await page.getByLabel('Reason (optional)').fill('Lost laptop')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Block member' }).click()
  await expect(page.getByText('Blocked by an admin')).toBeVisible()
  await expect(page.getByText(/^Blocked on .+: Lost laptop$/)).toBeVisible()

  expect(await canaryStatus(request, member.token)).toBe(401)
  expect(await canSignIn(request, member.email)).toBe(false)

  await choosePanelAction(page, 'Unblock')
  await expect(page.getByText('Can sign in')).toBeVisible()
  expect(await canSignIn(request, member.email)).toBe(true)
})

test("an admin can't block themselves", async ({ page, adminApi, adminSession }) => {
  const self = await adminApi.findMember(adminSession.email)

  await openMember(page, self.email)

  await panelMenu(page).click()
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Block' })).toHaveCount(0)
})

test('an admin grants and revokes admin', async ({ page, adminApi, request }) => {
  const member = await adminApi.seedMember()
  const adminStatus = () => adminRouteStatus(request, member.token)

  const adminSwitch = page.getByRole('switch', { name: 'Admin', exact: true })
  await openMember(page, member.email)
  await choosePanelAction(page, 'Edit')
  await adminSwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Granted by an admin')).toBeVisible()
  expect(await adminStatus()).toBe(200)

  await choosePanelAction(page, 'Edit')
  await adminSwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit Member' })).toHaveCount(0)
  await expect(page.getByText('Granted by an admin')).toHaveCount(0)
  expect(await adminStatus()).toBe(403)
})

test('after a SCIM DELETE, detaching the link lets a local member sign in by email code again', async ({
  page,
  adminApi,
  request,
}) => {
  test.slow()
  const member = await adminApi.seedMember()
  const { connection, token } = await adminApi.seedScimConnection()
  seededConnections.push(connection.id)
  const scim = (method: 'POST' | 'DELETE', path: string, data?: unknown) =>
    request.fetch(`${adminApiBaseUrl}${scimBasePath}${path}`, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' },
    })
  const scimUser = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    externalId: crypto.randomUUID(),
    userName: member.email,
    name: { givenName: 'E2E', familyName: 'Member' },
    emails: [{ value: member.email, type: 'work', primary: true }],
    active: true,
  }

  // The address already has a member, so the first create waits for an admin to approve the link.
  expect((await scim('POST', '/Users', scimUser)).status()).toBe(409)
  const { reviews } = await adminApi.request<LinkReviewPage>(
    'GET',
    `admin/link-reviews?status=pending&connectionId=${connection.id}`,
  )
  await adminApi.request('POST', `admin/link-reviews/${reviews[0].id}/approve`)
  const created = await scim('POST', '/Users', scimUser)
  expect(created.status()).toBe(201)
  const { id: scimId } = (await created.json()) as { id: string }
  expect((await scim('DELETE', `/Users/${scimId}`)).status()).toBe(204)
  expect(await canSignIn(request, member.email)).toBe(false)

  await openMember(page, member.email)
  await expect(page.getByText('Removed by the identity provider')).toBeVisible()
  await page.getByRole('button', { name: `Detach from ${connection.name}` }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Detach', exact: true }).click()

  await expect(page.getByText('Can sign in')).toBeVisible()
  await expect(page.getByRole('button', { name: `Detach from ${connection.name}` })).toHaveCount(0)
  expect(await canSignIn(request, member.email)).toBe(true)
})

test('a member who lost access can be deleted permanently', async ({ page, adminApi }) => {
  const member = await adminApi.seedMember()
  await adminApi.request('POST', `admin/members/${member.userId}/block`, {})

  await openMember(page, member.email)
  await choosePanelAction(page, 'Delete')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete member' }).click()

  await expect(page).toHaveURL(/\/admin\/members$/)
  await expect(adminApi.request('GET', `admin/members/${member.userId}`)).rejects.toThrow(/answered 404/)
})
