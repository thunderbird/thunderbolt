/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from './test'
import { collectPageErrors, loginViaOidc, logoutViaSidebar, openSidebarOnMobile } from './helpers'

test.describe('OIDC logout', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/*', (route) => {
      const hostname = new URL(route.request().url()).hostname
      return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? route.continue() : route.abort('blockedbyclient')
    })
  })

  test('lands on signed-out page after logout', async ({ page }) => {
    await loginViaOidc(page)
    await logoutViaSidebar(page)

    expect(page.url()).toContain('/signed-out')
    await expect(page.getByRole('heading', { name: 'Signed Out' })).toBeVisible()
    await expect(page.getByText('You have been signed out')).toBeVisible()
  })

  for (const failure of ['http', 'network'] as const) {
    test(`keeps the session on ${failure} sign-out failure and allows retry`, async ({ page }) => {
      const pageErrors = collectPageErrors(page)
      await loginViaOidc(page)
      const appUrl = page.url()
      const signOutRoute = '**/v1/api/auth/sign-out'
      await page.route(signOutRoute, async (route) => {
        if (failure === 'network') {
          await route.abort('failed')
          return
        }
        await route.fulfill({ status: 500, json: { message: 'Injected sign-out failure' } })
      })

      await openSidebarOnMobile(page)
      await page.locator('[data-sidebar="footer"]').getByRole('button').first().click()
      await page.getByText('Log out', { exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText('Delete data from device', { exact: true }).click()
      await dialog.getByRole('button', { name: 'Log out', exact: true }).click()

      await expect(dialog.getByRole('alert')).toHaveText('Could not confirm sign-out. Please try again.')
      await expect(page).toHaveURL(appUrl)
      await expect(dialog.getByRole('button', { name: 'Log out', exact: true })).toBeEnabled()
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
      await expect(dialog.getByRole('button', { name: /Delete data from device/ })).toBeEnabled()
      await expect(dialog.getByRole('button', { name: /Delete data from device/ })).toHaveClass(/border-destructive/)
      const session = await page.request.get('http://localhost:8002/v1/api/auth/get-session')
      expect(session.ok()).toBe(true)
      expect(await session.json()).toMatchObject({ user: { email: 'e2e@thunderbolt.test' } })

      await page.unroute(signOutRoute)
      await dialog.getByRole('button', { name: 'Log out', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Signed Out', exact: true })).toBeVisible()
      const signedOutSession = await page.request.get('http://localhost:8002/v1/api/auth/get-session')
      expect(signedOutSession.ok()).toBe(true)
      expect(await signedOutSession.json()).toBeNull()
      expect(pageErrors).toEqual([])
    })
  }

  test('can sign back in from the signed-out page', async ({ page }) => {
    await loginViaOidc(page)
    await logoutViaSidebar(page)

    // Click "Sign back in" — should trigger SSO flow and re-authenticate
    await page.getByRole('button', { name: 'Sign back in' }).click()

    // Should end up back in the authenticated app
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 30_000 })
  })

  test('does not auto-reauthenticate on the signed-out page', async ({ page }) => {
    await loginViaOidc(page)
    await logoutViaSidebar(page)

    // Wait a moment to confirm no auto-redirect happens
    await page.waitForTimeout(3_000)

    // Still on the signed-out page
    expect(page.url()).toContain('/signed-out')
    await expect(page.getByRole('heading', { name: 'Signed Out' })).toBeVisible()
  })
})
