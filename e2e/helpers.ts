import { expect, type Page } from '@playwright/test'

const MOCK_OIDC_PORT = 9876
const BACKEND_URL = 'http://localhost:8000'

/**
 * Intercepts the browser redirect to the mock IdP's /authorize endpoint and
 * bounces back to the backend's OIDC callback with a mock auth code + state.
 * This simulates "user logged in at the IdP" without needing a login UI.
 */
export const interceptOidcRedirect = (page: Page) => {
  return page.route(`http://localhost:${MOCK_OIDC_PORT}/authorize**`, (route) => {
    const url = new URL(route.request().url())
    const state = url.searchParams.get('state')
    const redirectUri = url.searchParams.get('redirect_uri')

    // Bounce back to the backend callback with a mock auth code
    route.fulfill({
      status: 302,
      headers: {
        Location: `${redirectUri}?code=mock-e2e-code&state=${state}`,
      },
    })
  })
}

/**
 * Navigate to the app root, handle the OIDC login flow (via route interception),
 * and wait for the authenticated chat UI to render.
 */
export const loginViaOidc = async (page: Page) => {
  await interceptOidcRedirect(page)
  await page.goto('/')

  // Wait for the OIDC flow to complete and land on the chat page
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 20_000 })
}

/**
 * Clear browser storage to ensure a fresh state.
 */
export const clearBrowserStorage = async (page: Page) => {
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
}

/**
 * Collect uncaught JS errors, filtering Tauri-specific noise.
 */
export const collectPageErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => {
    if (
      !error.message.includes('__TAURI__') &&
      !error.message.includes('tauri') &&
      !error.message.includes('window.__TAURI_INTERNALS__') &&
      !error.message.includes('convertFileSrc')
    ) {
      errors.push(error.message)
    }
  })
  return errors
}
