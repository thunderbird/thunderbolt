import { test, expect } from '@playwright/test'
import { loginViaOidc, interceptOidcRedirect, collectPageErrors } from './helpers'

test.describe('OIDC login flow', () => {
  test('unauthenticated user is redirected through OIDC and lands on chat', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)

    // Should be on an authenticated chat page
    await expect(page).toHaveURL(/\/chats\//)
    expect(errors).toHaveLength(0)
  })

  test('authenticated session persists across navigation', async ({ page }) => {
    await loginViaOidc(page)

    // Navigate to settings
    await page.goto('/settings')
    await expect(page.locator('h1, h2').filter({ hasText: /settings/i }).first()).toBeVisible({
      timeout: 10_000,
    })

    // Navigate back to chat
    await page.goto('/chats/new')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 })

    // Should NOT be redirected to OIDC again
    await expect(page).not.toHaveURL(/oidc-redirect/)
  })

  test('page loads without critical JS errors after OIDC login', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)

    // Navigate around to exercise the app
    await page.goto('/settings')
    await page.waitForTimeout(1000)
    await page.goto('/chats/new')
    await page.waitForTimeout(1000)

    expect(errors).toHaveLength(0)
  })
})

test.describe('OIDC redirect behavior', () => {
  test('unauthenticated visit to / redirects to /oidc-redirect', async ({ page }) => {
    // Do NOT set up the intercept — just observe the redirect
    const response = await page.goto('/')

    // The app should redirect to /oidc-redirect for unauthenticated users in OIDC mode
    await expect(page).toHaveURL(/oidc-redirect/, { timeout: 10_000 })
  })

  test('direct visit to /oidc-redirect triggers IdP redirect', async ({ page }) => {
    // Intercept the IdP redirect to verify it happens
    let idpRedirectCaptured = false
    await page.route('http://localhost:9876/authorize**', (route) => {
      idpRedirectCaptured = true
      // Abort so we don't complete the flow
      route.abort()
    })

    await page.goto('/oidc-redirect')
    await page.waitForTimeout(5000)

    expect(idpRedirectCaptured).toBe(true)
  })
})
