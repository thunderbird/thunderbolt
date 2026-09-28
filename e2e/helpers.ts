/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'

// Matches testSignInOtp in backend/src/auth/otp-constants.ts (NODE_ENV=test only).
const e2eSignInCode = '12345678'

/**
 * Request an email code through the entry page, complete verification, and
 * wait for the authenticated chat UI (onboarding is disabled in the e2e config).
 */
export const loginViaEmailCode = async (page: Page) => {
  const email = `e2e-${crypto.randomUUID()}@thunderbolt.test`
  // Returning users can see this dialog after the chat has already rendered.
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Welcome', exact: true }), async (dialog) => {
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  })
  await page.goto('/')
  await page.getByPlaceholder('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('input[autocomplete="one-time-code"]').fill(e2eSignInCode)
  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 })
  return email
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
  if ((page.viewportSize()?.width ?? 768) >= 768) return
  const openDrawer = page.locator('[data-slot="sidebar"][data-mobile="true"][data-open]')
  if (await openDrawer.count()) return
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
