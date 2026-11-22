/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import type { OrgDomain } from '../shared/admin-api'
import { adminTest as test } from './admin/helpers'

/** The two reasons a domain with no record can fail on: which one depends on the resolver the backend reaches. */
const missingRecordReason =
  /No verification record was found\. DNS changes can take a while to appear\.|The DNS lookup failed\. Try again later\./

const added: string[] = []

test.afterEach(async ({ adminApi }) => {
  const { items } = await adminApi.request<{ items: OrgDomain[] }>('GET', 'admin/domains')
  const leftovers = items.filter((domain) => added.includes(domain.domain))
  await Promise.all(leftovers.map((domain) => adminApi.request('DELETE', `admin/domains/${domain.id}`)))
  added.length = 0
})

test('an admin adds a domain, sees its record, fails to verify it and removes it', async ({ page, adminApi }) => {
  const domain = `e2e-${crypto.randomUUID().slice(0, 8)}.thunderbolt.test`
  added.push(domain)

  await page.goto('/admin/domains')
  await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Add domain' }).click()
  const form = page.locator('form', { has: page.getByRole('textbox', { name: 'Domain' }) })
  await form.getByRole('textbox', { name: 'Domain' }).fill(domain)
  await form.getByRole('button', { name: 'Add domain' }).click()

  await expect(page.getByRole('heading', { name: domain, exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Record name' })).toHaveValue(`_thunderbolt-verification.${domain}`)
  await expect(page.getByRole('textbox', { name: 'Record value' })).toHaveValue(/^thunderbolt-verification=\S+$/)

  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  // The backend's resolver retries before it gives up on a lookup.
  await expect(page.getByText('The last check failed')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(missingRecordReason)).toBeVisible()
  const enrollment = page.getByRole('switch', { name: 'Open to enrollment' })
  await expect(enrollment).toBeDisabled()
  await expect(enrollment).toHaveAccessibleDescription(/Verify this domain before opening it to enrollment\./)

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Remove domain' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(`Remove ${domain}?`)
  await confirm.getByRole('button', { name: 'Remove domain' }).click()

  await expect(confirm).toBeHidden()
  await expect(page.getByRole('button', { name: domain })).toHaveCount(0)
  const { items } = await adminApi.request<{ items: OrgDomain[] }>('GET', 'admin/domains')
  expect(items.map((item) => item.domain)).not.toContain(domain)
})
