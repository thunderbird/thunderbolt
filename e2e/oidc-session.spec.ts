/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { loginViaOidc } from './helpers'

test.describe('OIDC session', () => {
  test('chat UI is fully functional after OIDC login', async ({ page }) => {
    await loginViaOidc(page)

    // Verify the chat textarea is interactive
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()
    await textarea.click()
    await textarea.pressSequentially('Hello from e2e test')
    await expect(textarea).toHaveValue('Hello from e2e test')
  })

  test('sidebar navigation works after OIDC login', async ({ page }) => {
    await loginViaOidc(page)

    // Look for sidebar navigation elements
    const sidebar = page.locator('aside, [data-sidebar]').first()
    await expect(sidebar).toBeVisible({ timeout: 10_000 })
  })

  test('user is signed in after OIDC login', async ({ page }) => {
    await loginViaOidc(page)

    // Navigate to settings — should NOT show "Sign In" button
    await page.goto('/settings')
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 })

    // A signed-in user should not see the "Sign In" button
    await expect(page.getByRole('button', { name: 'Sign In' })).not.toBeVisible({ timeout: 5_000 })
  })
})
