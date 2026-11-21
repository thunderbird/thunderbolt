/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type BrowserContext, type Page } from '@playwright/test'

const localSettingsKey = 'thunderbolt-local-settings'
const appOrigin = new URL(process.env.A11Y_BASE_URL ?? 'http://localhost:1420').origin

/** False on pages the app doesn't own (the Keycloak login), where its theme follows nothing we control. */
export const canSetTheme = (page: Page) => new URL(page.url()).origin === appOrigin

/**
 * Make the app follow `prefers-color-scheme` in every page of this context. A stored theme choice wins
 * over the operator's `defaultThemeMode`, so pinning it to `system` makes `emulateMedia` flip the theme live,
 * with no reload that would throw away the screen being audited. Runs before the app's own scripts.
 */
export const followSystemTheme = (context: BrowserContext) =>
  context.addInitScript(
    ([key, origin]) => {
      if (location.origin !== origin) {
        return
      }
      const stored = JSON.parse(localStorage.getItem(key) ?? '{"state":{},"version":1}')
      localStorage.setItem(key, JSON.stringify({ ...stored, state: { ...stored.state, theme: 'system' } }))
    },
    [localSettingsKey, appOrigin],
  )

/** The id of the style element `disableTransitions` installs. */
const noTransitionsId = 'a11y-no-transitions'

/**
 * Turn off CSS transitions and animations in every page of this context. About 45 components use
 * `transition-colors`, so right after a theme flip axe could read colors mid-transition. Runs before the
 * app's own scripts and applies to every origin, including the Keycloak login.
 */
export const disableTransitions = (context: BrowserContext) =>
  context.addInitScript((id) => {
    const install = () => {
      if (document.getElementById(id)) {
        return
      }
      const style = document.createElement('style')
      style.id = id
      style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'
      document.documentElement.append(style)
    }
    // Init scripts can run before the root element exists; install the style as soon as it does.
    if (document.documentElement) {
      install()
      return
    }
    new MutationObserver((_records, observer) => {
      if (document.documentElement) {
        install()
        observer.disconnect()
      }
    }).observe(document, { childList: true })
  }, noTransitionsId)

/** Switch the OS color scheme and wait for the app's root class to follow, with transitions confirmed off. */
export const setColorScheme = async (page: Page, scheme: 'light' | 'dark') => {
  await expect(page.locator(`#${noTransitionsId}`)).toHaveCount(1)
  await page.emulateMedia({ colorScheme: scheme })
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${scheme}\\b`))
}
