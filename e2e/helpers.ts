/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'

// Matches testSignInOtp in backend/src/auth/otp-constants.ts (NODE_ENV=test only).
const e2eSignInCode = '12345678'

/**
 * The backend refuses a second code for the same email within `defaultCooldownMs` (waitlist/routes.ts); `wait` sleeps
 * out what remains for an address this process already asked. Tests inject `now` and `sleep`.
 */
export const createOtpCooldown = (
  now = Date.now,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
) => {
  const requestTimes = new Map<string, number>()
  return {
    wait: async (email: string) => {
      const lastRequest = requestTimes.get(email)
      const remaining = lastRequest === undefined ? 0 : 15_250 - (now() - lastRequest)
      if (remaining > 0) {
        await sleep(remaining)
      }
    },
    // Stamped after the response, so it is never earlier than the server's own cooldown timestamp.
    requested: (email: string) => requestTimes.set(email, now()),
  }
}

const otpCooldown = createOtpCooldown()

/**
 * Signs in up to the code and awaits nothing after it, so it works with onboarding on. Signing in again with the same
 * address first waits out the backend's cooldown. Returns the address.
 */
export const enterEmailCode = async (page: Page, email = `e2e-${crypto.randomUUID()}@thunderbolt.test`) => {
  await page.goto('/')
  await otpCooldown.wait(email)
  await page.getByPlaceholder('Email', { exact: true }).fill(email)
  const codeRequested = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/waitlist/join')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await codeRequested
  otpCooldown.requested(email)
  await page.locator('input[autocomplete="one-time-code"]').fill(e2eSignInCode)
  return email
}

/**
 * Request an email code through the entry page, complete verification, and
 * wait for the authenticated chat UI (onboarding is disabled in the e2e config).
 * Pass the email a previous call returned to sign a second browser context into the same account.
 */
export const loginViaEmailCode = async (page: Page, email?: string) => {
  // Returning users can see this dialog after the chat has already rendered.
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Welcome', exact: true }), async (dialog) => {
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  })
  const signedIn = await enterEmailCode(page, email)
  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 })
  return signedIn
}

/**
 * Navigate to the app root, let the SSO flow complete naturally through
 * the mock identity provider, and wait for the authenticated chat UI to render.
 *
 * Onboarding is disabled via VITE_SKIP_ONBOARDING env var in playwright.config.ts.
 */

/**
 * OIDC flow: / -> AuthGate -> /sso-redirect -> POST sign-in/sso -> mock IdP /authorize
 * (auto-approves) -> backend callback -> token exchange -> session -> app
 */
export const loginViaOidc = async (page: Page) => {
  await page.goto('/')
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 30_000 })
}

/**
 * SAML flow: / -> AuthGate -> /sso-redirect -> POST sign-in/sso -> mock IdP /saml/sso
 * (auto-generates SAMLResponse) -> POST to ACS -> session -> app
 */
export const loginViaSaml = async (page: Page) => {
  await page.goto('/')
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 30_000 })
}

/** Open the chat sidebar when the mobile drawer is closed; desktop already renders it. */
export const openSidebarOnMobile = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 768) >= 768) {
    return
  }
  const openDrawer = page.locator('[data-slot="sidebar"][data-mobile="true"][data-open]')
  if (await openDrawer.count()) {
    return
  }
  await page.locator('[data-slot="create-item-layout"] header').first().getByRole('button').first().click()
  await expect(openDrawer).toBeVisible()
}

/**
 * Open the account popover, click "Log out", confirm in the modal, and wait
 * for the signed-out landing page to appear.
 *
 * Expects the caller to have already authenticated (e.g. via loginViaOidc / loginViaSaml).
 */
export const logoutViaSidebar = async (page: Page, option: 'keep' | 'delete' = 'keep') => {
  await openSidebarOnMobile(page)
  const accountTrigger = page.locator('[data-sidebar="footer"]').getByRole('button').first()
  await accountTrigger.click()
  await page.getByText('Log out', { exact: true }).click()

  // Pick the data option if "delete" is requested (default is "keep")
  if (option === 'delete') {
    await page.getByText('Delete data from device').click()
  }

  // Confirm logout
  await page.getByRole('button', { name: 'Log out' }).click()

  // Should land on the signed-out page
  await expect(page.getByRole('heading', { name: 'Signed Out' })).toBeVisible({ timeout: 10_000 })
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

/** Send a message through the app's chat composer. */
export const sendChatPrompt = async (page: Page, prompt: string) => {
  await page.locator('textarea').fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
}
