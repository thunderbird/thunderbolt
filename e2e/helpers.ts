/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'

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
