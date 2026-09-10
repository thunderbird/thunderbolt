/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * THU-829 — the language picker, asserted on intercepted `X-App-Language`
 * request headers rather than translated UI copy.
 *
 * Every bug this file guards against was a cross-boundary timing bug the unit
 * suite cannot see by construction (see oidc-localization.spec.ts's header):
 * settings hydration publishing `en` over the boot-seeded locale and destroying
 * its localStorage mirror, the schema fallback making an unset setting
 * indistinguishable from an explicit English choice, and a stale mirror
 * surviving a data wipe into the next identity. The races live in the reload
 * and fresh-context sequences, so that is what these tests drive.
 *
 * Where a test has to operate German UI (everything after a switch to Deutsch),
 * it goes through catalog copy deliberately — the same convention as
 * oidc-localization.spec.ts's `Lokalisierung` assertion. The coupled strings
 * are collected in `de` below so a catalog change breaks one constant, not
 * selectors scattered across the file.
 */

const oidcVitePort = 1421
const oidcBackendPort = 8002
const oidcOrigin = `http://localhost:${oidcVitePort}`
const backendOrigin = `http://localhost:${oidcBackendPort}`

/** localStorage key of the boot-time locale mirror (src/i18n/active-locale.ts). */
const mirrorKey = 'thunderbolt_locale'

/** The German catalog copy these tests drive the UI through. */
const de = {
  language: 'Sprache',
  localization: 'Lokalisierung',
  modifiedItem: 'Geändertes Element',
  defaultSetting: 'Standardeinstellung',
  resetToDefault: 'Auf Standard zurücksetzen',
  logOut: 'Abmelden',
  deleteDataFromDevice: 'Daten vom Gerät löschen',
}

/** Start collecting every request the page issues, in order. */
const collectRequests = (page: Page): Request[] => {
  const requests: Request[] = []
  page.on('request', (request) => requests.push(request))
  return requests
}

/**
 * The `x-app-language` header of every captured backend request, in request
 * order. Requests torn down before their headers could be read (e.g. cancelled
 * by a reload) are skipped rather than failing the poll that wraps this.
 */
const appLanguageHeaders = async (requests: Request[]): Promise<string[]> => {
  const headers: string[] = []
  for (const request of requests) {
    if (!request.url().startsWith(backendOrigin)) {
      continue
    }
    const language = await request.allHeaders().then(
      (all) => all['x-app-language'],
      () => undefined,
    )
    if (language) {
      headers.push(language)
    }
  }
  return headers
}

/**
 * Fulfill an intercepted cross-origin backend request with CORS headers echoed
 * the way the real backend answers them, so the browser exposes the response to
 * app code (same shape as min-version-gate.spec.ts). Preflights get a 204.
 */
const fulfillWithCors = (route: Route, body: unknown): Promise<void> => {
  const req = route.request()
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': oidcOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers()['access-control-request-headers'] ?? '*',
  }
  if (req.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: cors })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
}

/**
 * Type into the Location search on /settings/preferences and return the
 * `X-App-Language` its backend request carried. This is the one in-app action
 * that reliably issues a backend request without a reload, which is exactly
 * what "the header flipped mid-session" needs. The request is intercepted with
 * an empty result set, so no geocoding upstream is involved — the header is
 * the subject, not the response.
 */
const languageHeaderOfLocationSearch = async (page: Page, query: string): Promise<string | null> => {
  const captured = new Promise<string | null>((resolve) => {
    void page.route('**/v1/locations*', async (route) => {
      const isPreflight = route.request().method() === 'OPTIONS'
      const language = route.request().headers()['x-app-language'] ?? null
      await fulfillWithCors(route, [])
      if (!isPreflight) {
        resolve(language)
      }
    })
  })

  await page.locator('#localization-location-trigger').click()
  await page.locator('[cmdk-input]').fill(query)
  const language = await captured
  await page.keyboard.press('Escape')
  await page.unroute('**/v1/locations*')
  return language
}

const openLocalizationSettings = async (page: Page) => {
  await page.goto('/settings/preferences')
  await expect(page.getByTestId('language')).toBeVisible({ timeout: 30_000 })
}

/**
 * Pick Deutsch and wait for both halves of the change: the catalog chunk
 * rendering (the synchronous publish) and the label reporting itself modified
 * (the asynchronous settings write landing — the watched query has re-emitted).
 * Reloading before the second signal would race the write and boot from a
 * mirror whose backing row doesn't exist yet.
 */
const pickGerman = async (page: Page) => {
  await page.getByTestId('language').click()
  await page.getByRole('option', { name: 'Deutsch' }).click()
  await expect(page.getByText(de.localization)).toBeVisible()
  await expect(page.locator(`label[aria-label="${de.modifiedItem}"]`).filter({ hasText: de.language })).toBeVisible()
}

test.describe('language picker — X-App-Language', () => {
  test.use({ locale: 'en-US' })

  test('picking a language flips the header on in-app requests without a reload', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)
    await openLocalizationSettings(page)

    expect(await languageHeaderOfLocationSearch(page, 'Dublin')).toBe('en')

    await pickGerman(page)

    expect(await languageHeaderOfLocationSearch(page, 'Berlin')).toBe('de')
    // Mirrored for the next boot — this is what the reload test below leans on.
    expect(await page.evaluate((key) => localStorage.getItem(key), mirrorKey)).toBe('de')

    expect(errors).toEqual([])
  })

  test('a reload boots from the picked language — the first request already carries it', async ({ page }) => {
    await loginViaOidc(page)
    await openLocalizationSettings(page)
    await pickGerman(page)

    const requests = collectRequests(page)
    await page.reload()
    await expect(page.getByText(de.localization)).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await appLanguageHeaders(requests)).length, { timeout: 30_000 }).toBeGreaterThan(0)

    // Settings hydration used to publish `en` over the boot-seeded locale, so
    // requests that beat hydration carried the wrong tag and the mirror was
    // destroyed again on every load (THU-808). Not one request may announce
    // English — first of all not the first.
    const headers = await appLanguageHeaders(requests)
    expect(headers[0]).toBe('de')
    expect(headers).not.toContain('en')
  })

  test('resetting to auto returns the header to the negotiated language', async ({ page }) => {
    await loginViaOidc(page)
    await openLocalizationSettings(page)
    await pickGerman(page)

    await page.locator(`label[aria-label="${de.modifiedItem}"]`).filter({ hasText: de.language }).click()
    await page.getByRole('button', { name: de.resetToDefault }).click()

    // en-US negotiates back to English: catalog copy flips and the row reads as
    // a default again (the dropdown itself has no "auto" option — the reset
    // affordance is the only way back, which is exactly why it gets coverage).
    await expect(page.getByText('Localization')).toBeVisible()
    await expect(page.locator('label[aria-label="Default setting"]').filter({ hasText: 'Language' })).toBeVisible()

    expect(await languageHeaderOfLocationSearch(page, 'Dublin')).toBe('en')
  })

  test('signing out with a data wipe clears the language mirror', async ({ page }) => {
    await loginViaOidc(page)
    await openLocalizationSettings(page)
    await pickGerman(page)
    expect(await page.evaluate((key) => localStorage.getItem(key), mirrorKey)).toBe('de')

    // Log out from the chat layout's sidebar (mirrors helpers.logoutViaSidebar,
    // driven through the German catalog because the UI is German by now). The
    // account popover can close under a re-render right after the language
    // switch, detaching the menu item mid-click — so the open-and-click pair
    // retries as a unit until the item takes the click.
    await page.goto('/')
    const accountTrigger = page.locator('[data-sidebar="footer"]').getByRole('button').first()
    const logOutItem = page.getByText(de.logOut, { exact: true })
    await expect(async () => {
      if (!(await logOutItem.isVisible())) {
        await accountTrigger.click()
      }
      await logOutItem.click({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    await page.getByText(de.deleteDataFromDevice).click()
    await page.getByRole('button', { name: de.logOut }).click()

    // The wipe drops the mirror and republishes the negotiated locale, so the
    // signed-out page already renders in English (THU-808: a stale mirror used
    // to boot the next identity in the previous account's language). The key
    // itself reappears at once — publishing the renegotiated locale re-mirrors
    // it — so the assertion is on the value: the browser's language, not the
    // wiped account's German.
    await expect(page.getByRole('heading', { name: 'Signed Out' })).toBeVisible({ timeout: 10_000 })
    expect(await page.evaluate((key) => localStorage.getItem(key), mirrorKey)).toBe('en')

    // And the next session negotiates from the browser, not from leftovers.
    const requests = collectRequests(page)
    await loginViaOidc(page)
    await expect.poll(async () => (await appLanguageHeaders(requests)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(await appLanguageHeaders(requests)).not.toContain('de')
  })
})

test.describe('language picker — fresh non-English browser, no stored setting', () => {
  test.use({ locale: 'de-DE' })

  test('negotiates the browser language before any setting exists, never announcing English', async ({ page }) => {
    const errors = collectPageErrors(page)
    const requests = collectRequests(page)

    await loginViaOidc(page)
    await openLocalizationSettings(page)
    await expect(page.getByText(de.localization)).toBeVisible()

    await expect.poll(async () => (await appLanguageHeaders(requests)).length, { timeout: 30_000 }).toBeGreaterThan(0)

    // The `language` setting ships as null and the schema fallback reads as
    // `en`; treating that fallback as an explicit choice used to publish
    // English between hydration and the async seed write (THU-808). From the
    // very first request, negotiation must already have won.
    const headers = await appLanguageHeaders(requests)
    expect(headers[0]).toBe('de')
    expect(headers).not.toContain('en')

    // Negotiation seeded, but did not fake an edit: the trigger shows Deutsch
    // while the row still reads as a default (seeding writes `recomputeHash`).
    await expect(page.getByTestId('language')).toHaveText('Deutsch')
    await expect(
      page.locator(`label[aria-label="${de.defaultSetting}"]`).filter({ hasText: de.language }),
    ).toBeVisible()

    expect(await page.evaluate((key) => localStorage.getItem(key), mirrorKey)).toBe('de')
    expect(errors).toEqual([])
  })
})
