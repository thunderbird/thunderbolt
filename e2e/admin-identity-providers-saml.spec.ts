/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import type { AdminMember, Page as ApiPage } from '../shared/admin-api'
import {
  adminSamlIdpUrl,
  adminTest as test,
  retireConnection,
  signInThroughConnection,
  uniqueEmail,
  uniqueName,
} from './admin/helpers'
import { generateTestCerts } from './saml-test-certs'

const seeded: string[] = []

test.afterEach(async ({ adminApi }) => {
  for (const connectionId of seeded.splice(0)) {
    await retireConnection(adminApi, connectionId)
  }
})

test('an admin adds a SAML connection, and people sign in through it', async ({
  page,
  browser,
  viewport,
  adminApi,
  request,
}) => {
  test.slow()
  const name = uniqueName('SAML')
  const providerId = `e2e-saml-${crypto.randomUUID().slice(0, 8)}`
  const cert = await (await request.get(`${adminSamlIdpUrl}/cert`)).text()

  await page.goto('/admin/sign-in-methods')
  await page.getByRole('button', { name: 'New Sign-in Method' }).click()
  await page.getByRole('button', { name: /^SAML single sign-on/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Provider ID').fill(providerId)
  await expect(page.getByRole('textbox', { name: 'Assertion consumer service URL' })).toHaveValue(
    new RegExp(`/v1/api/auth/sso/saml2/sp/acs/${providerId}$`),
  )
  await page.getByLabel('Service provider entity ID').fill(`thunderbolt-${providerId}`)
  await page.getByLabel('Sign-in URL').fill(`${adminSamlIdpUrl}/saml/sso`)
  await page.getByLabel('Identity provider issuer').fill(adminSamlIdpUrl)
  await page.getByLabel('Signing certificate').fill(cert)
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(page.getByText(`thunderbolt-${providerId}`, { exact: true })).toBeVisible()
  const connectionId = await adminApi.connectionIdByName(name)
  seeded.push(connectionId)

  // The same person signs in twice and stays one member.
  const identity = { sub: `e2e-sub-${crypto.randomUUID()}`, email: uniqueEmail('saml') }
  for (const attempt of [1, 2]) {
    const signIn = await signInThroughConnection(browser, viewport, name, identity)
    await expect(signIn.page, `sign-in ${attempt}`).toHaveURL(/\/chats\//)
    await signIn.close()
  }
  const members = await adminApi.request<ApiPage<AdminMember>>(
    'GET',
    `admin/members?q=${encodeURIComponent(identity.email)}`,
  )
  expect(members.items.filter((member) => member.email === identity.email)).toHaveLength(1)

  // Control: a certificate the IdP doesn't sign with refuses the response, so the signature is checked.
  await adminApi.request('PATCH', `admin/connections/${connectionId}`, {
    saml: { cert: generateTestCerts().certSingleLine },
  })
  const refused = await signInThroughConnection(browser, viewport, name, identity)
  await expect(refused.page).toHaveURL(/\/sso-error/)
  await refused.close()
})
