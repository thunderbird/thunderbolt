/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'

export type AppTheme = 'light' | 'dark'

const localSettingsKey = 'thunderbolt-local-settings'
const appOrigin = new URL(process.env.A11Y_BASE_URL ?? 'http://localhost:1420').origin

/** False on pages the app doesn't own (the Keycloak login), where its theme setting does nothing. */
export const canSetTheme = (page: Page) => new URL(page.url()).origin === appOrigin

/**
 * Select the app's own theme setting and check the root class took effect. `emulateMedia` alone only
 * works while the theme is `system`; an operator default of light or dark would make both scans identical.
 * The setting is read at startup, so this reloads the page.
 */
export const setAppTheme = async (page: Page, theme: AppTheme) => {
  await page.evaluate(
    ([key, value]) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{"state":{},"version":1}')
      localStorage.setItem(key, JSON.stringify({ ...stored, state: { ...stored.state, theme: value } }))
    },
    [localSettingsKey, theme],
  )
  await page.reload()
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
}
