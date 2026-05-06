import { test, expect } from '@playwright/test'
import { loginViaSaml, collectPageErrors } from './helpers'

test.describe('SAML login flow', () => {
  test('unauthenticated user is redirected through SAML and lands on chat', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaSaml(page)

    await expect(page).toHaveURL(/\/chats\//)
    expect(errors).toHaveLength(0)
  })

  test('authenticated session persists across navigation', async ({ page }) => {
    await loginViaSaml(page)

    await page.goto('/settings')
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 })

    await page.goto('/chats/new')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 })

    await expect(page).not.toHaveURL(/sso-redirect/)
  })

  test('page loads without critical JS errors after SAML login', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaSaml(page)

    await page.goto('/settings')
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 })
    await page.goto('/chats/new')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 })

    expect(errors).toHaveLength(0)
  })
})

test.describe('SAML redirect behavior', () => {
  test('unauthenticated visit triggers SAML flow', async ({ page }) => {
    // Visit the app — should eventually hit the mock SAML IdP
    const responsePromise = page.waitForResponse(/\/saml\/sso/, { timeout: 15_000 })

    await page.goto('/')

    const response = await responsePromise
    const url = new URL(response.url())
    expect(url.searchParams.get('SAMLRequest')).toBeTruthy()
  })
})
