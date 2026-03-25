import { test, expect } from '@playwright/test'
import { loginViaOidc } from './helpers'

test.describe('OIDC session', () => {
  test('user info from OIDC claims is accessible in the app', async ({ page }) => {
    await loginViaOidc(page)

    // Navigate to settings where user info is typically displayed
    await page.goto('/settings')

    // The mock OIDC server sets email to 'e2e@thunderbolt.test'
    await expect(page.getByText('e2e@thunderbolt.test')).toBeVisible({ timeout: 10_000 })
  })

  test('chat UI is fully functional after OIDC login', async ({ page }) => {
    await loginViaOidc(page)

    // Verify the chat textarea is interactive
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()
    await textarea.fill('Hello from e2e test')
    await expect(textarea).toHaveValue('Hello from e2e test')
  })

  test('sidebar navigation works after OIDC login', async ({ page }) => {
    await loginViaOidc(page)

    // Look for sidebar navigation elements
    const sidebar = page.locator('aside, [data-sidebar]').first()
    await expect(sidebar).toBeVisible({ timeout: 10_000 })
  })
})
