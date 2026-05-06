/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { loginViaSaml, logoutViaSidebar } from './helpers'

test.describe('SAML logout', () => {
  test('lands on signed-out page after logout', async ({ page }) => {
    await loginViaSaml(page)
    await logoutViaSidebar(page)

    expect(page.url()).toContain('/signed-out')
    await expect(page.getByRole('heading', { name: 'Signed Out' })).toBeVisible()
    await expect(page.getByText('You have been signed out')).toBeVisible()
  })

  test('can sign back in from the signed-out page', async ({ page }) => {
    await loginViaSaml(page)
    await logoutViaSidebar(page)

    // Click "Sign back in" — should trigger SSO flow and re-authenticate
    await page.getByRole('button', { name: 'Sign back in' }).click()

    // Should end up back in the authenticated app
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 30_000 })
  })

  test('does not auto-reauthenticate on the signed-out page', async ({ page }) => {
    await loginViaSaml(page)
    await logoutViaSidebar(page)

    // Wait a moment to confirm no auto-redirect happens
    await page.waitForTimeout(3_000)

    // Still on the signed-out page
    expect(page.url()).toContain('/signed-out')
    await expect(page.getByRole('heading', { name: 'Signed Out' })).toBeVisible()
  })
})
