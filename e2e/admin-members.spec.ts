/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type APIRequestContext } from '@playwright/test'
import { scimBasePath, type LinkReviewPage } from '../shared/admin-api'
import {
  adminApiBaseUrl,
  adminRouteStatus,
  adminTest as test,
  otpCooldownMs,
  requestEmailCodeSignIn,
  retireConnection,
  uniqueName,
} from './admin/helpers'

/** A route any signed-in member may call: 401 once their access is gone. */
const canaryStatus = async (request: APIRequestContext, token: string) =>
  (
    await request.get(`${adminApiBaseUrl}/encryption/canary`, { headers: { Authorization: `Bearer ${token}` } })
  ).status()

/** Whether `email` can sign in by email code right now, over HTTP. Waits out the code cooldown once. */
const canSignIn = async (request: APIRequestContext, email: string) => {
  const first = await requestEmailCodeSignIn(request, email)
  if (first.status() !== 429) {
    return first.ok()
  }
  await new Promise((done) => setTimeout(done, otpCooldownMs))
  return (await requestEmailCodeSignIn(request, email)).ok()
}

const seededConnections: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seededConnections.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

test('an admin finds a member by search and renames them', async ({ page, adminApi }) => {
  const member = await adminApi.seedMember()
  const name = uniqueName('Renamed')

  await page.goto('/admin/members')
  // The page's search toggle; on desktop the sidebar's app-wide Search comes first.
  await page.getByRole('button', { name: 'Search', exact: true }).last().click()
  await page.getByRole('searchbox', { name: 'Search members' }).fill(member.email)
  await page.getByText(member.email, { exact: true }).first().click()

  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
})

test('blocking a member refuses their next request, and unblocking lets them sign in again', async ({
  page,
  adminApi,
  request,
}) => {
  test.slow()
  const member = await adminApi.seedMember()
  expect(await canaryStatus(request, member.token)).not.toBe(401)

  await page.goto(`/admin/members?edit=${member.userId}`)
  await page.getByRole('button', { name: 'Block', exact: true }).click()
  await page.getByLabel('Reason (optional)').fill('Lost laptop')
  await page.getByRole('button', { name: 'Block member' }).click()
  await expect(page.getByText('Blocked by an admin')).toBeVisible()
  await expect(page.getByText(/Lost laptop/)).toBeVisible()

  expect(await canaryStatus(request, member.token)).toBe(401)
  expect(await canSignIn(request, member.email)).toBe(false)

  await page.getByRole('button', { name: 'Unblock' }).click()
  await expect(page.getByText('Can sign in')).toBeVisible()
  expect(await canSignIn(request, member.email)).toBe(true)
})

test("an admin can't block themselves", async ({ page, adminApi, adminSession }) => {
  const self = await adminApi.findMember(adminSession.email)

  await page.goto(`/admin/members?edit=${self.userId}`)

  const block = page.getByRole('button', { name: 'Block', exact: true })
  await expect(block).toBeDisabled()
  await expect(block).toHaveAccessibleDescription("You can't block yourself.")
})

test('an admin grants and revokes admin', async ({ page, adminApi, request }) => {
  const member = await adminApi.seedMember()
  const adminStatus = () => adminRouteStatus(request, member.token)

  await page.goto(`/admin/members?edit=${member.userId}`)
  await page.getByRole('button', { name: 'Make admin' }).click()
  await expect(page.getByText('Granted by an admin')).toBeVisible()
  expect(await adminStatus()).toBe(200)

  await page.getByRole('button', { name: 'Revoke admin' }).click()
  await expect(page.getByRole('button', { name: 'Make admin' })).toBeVisible()
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

  await page.goto(`/admin/members?edit=${member.userId}`)
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

  await page.goto(`/admin/members?edit=${member.userId}`)
  await page.getByRole('button', { name: 'Delete member' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete member' }).click()

  await expect(page).toHaveURL(/\/admin\/members$/)
  await expect(adminApi.request('GET', `admin/members/${member.userId}`)).rejects.toThrow(/answered 404/)
})
