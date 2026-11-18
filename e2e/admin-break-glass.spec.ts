/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import type { BreakGlassStatus } from '../shared/admin-api'
import { adminAppUrl, adminTest as test } from './admin/helpers'

test('the break-glass page counts the local admins and gives the email-code sign-in address', async ({
  page,
  adminApi,
}) => {
  // Bootstrap admins sign in by email code, so the org always has a local admin here.
  const status = await adminApi.request<BreakGlassStatus>('GET', 'admin/break-glass')
  expect(status.allAdminsIdpManaged).toBe(false)

  await page.goto('/admin/break-glass')

  await expect(page.getByText(/^\d+ admins? can sign in without your identity provider$/)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Email-code sign-in address' })).toHaveValue(
    `${adminAppUrl}/sign-in/email-code`,
  )
  await expect(page.getByRole('button', { name: 'Copy the sign-in address' })).toBeVisible()
})
