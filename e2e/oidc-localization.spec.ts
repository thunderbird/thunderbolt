/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * The only place the localization layer is exercised for real.
 *
 * Three things are structurally invisible to the bun suite, and all three are
 * load-bearing:
 *
 *  - **Catalogs.** `src/testing-library.ts` mocks the Lingui macros with
 *    identity implementations that return the English source, so no unit test
 *    has ever rendered a translated string. Every "German" assertion there is
 *    really `Intl` output with an English catalog half.
 *  - **Live queries.** The PowerSync test mock's `onChangeWithCallback` is a
 *    no-op, so a watched query never re-emits after a write. That is why
 *    `use-unit-defaults.test.tsx` reads the database directly — nothing proves
 *    a seeded value reaches the screen.
 *  - **The boot chain.** `useUnitDefaults` is mounted in `AppContent`, which no
 *    unit test mounts.
 *
 * A fourth, quieter one: bun and Chrome ship different ICU builds, and the unit
 * tests pin exact CLDR output. A divergence would otherwise be silent.
 *
 * Controls are addressed by `data-testid` rather than by their `aria-label`,
 * which is itself translated — selecting on it would couple these tests to
 * catalog copy.
 */

const openLocalizationSettings = async (page: Page) => {
  await page.goto('/settings/preferences')
  await expect(page.getByTestId('distance-unit')).toBeVisible({ timeout: 30_000 })
}

test.describe('localization — unit defaults', () => {
  test.use({ locale: 'de-DE' })

  test('seeds German units from the browser region and renders them translated', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)
    await openLocalizationSettings(page)

    // Seeding is asynchronous (settings query resolves → effect → write →
    // watched query re-emits), so wait on the value rather than reading once.
    await expect(page.getByTestId('distance-unit')).toHaveText('Metrisch (km)')
    await expect(page.getByTestId('temperature-unit')).toHaveText('Celsius (°C)')
    // A rendered example, not the stored '24h' token.
    await expect(page.getByTestId('time-format')).toHaveText('13:30')
    await expect(page.getByTestId('currency')).toContainText('Euro')

    expect(errors).toEqual([])
  })

  test('never falls back to US units', async ({ page }) => {
    // The pre-THU-810 behaviour: no location meant an authenticated round trip
    // that defaulted to `US`, so a German browser landed on imperial and
    // Fahrenheit whatever the locale said.
    await loginViaOidc(page)
    await openLocalizationSettings(page)

    await expect(page.getByTestId('distance-unit')).toHaveText('Metrisch (km)')
    await expect(page.getByTestId('temperature-unit')).not.toContainText('Fahrenheit')
    await expect(page.getByTestId('currency')).not.toContainText('Dollar')
  })

  test('retires the date format row', async ({ page }) => {
    await loginViaOidc(page)
    await openLocalizationSettings(page)

    await expect(page.getByTestId('distance-unit')).toBeVisible()
    await expect(page.getByText('Datumsformat')).toHaveCount(0)
    await expect(page.getByText('Date Format')).toHaveCount(0)
  })
})

test.describe('localization — language switching', () => {
  /**
   * Ireland, not the US. The UI still negotiates to the `en` catalog, but the
   * region seeds metric — so "Metric" → "Metrisch" is a label that visibly
   * changes on switch. Under `en-US` every unit label happens to be identical
   * in both languages ("Imperial", "Fahrenheit", "1:30 PM"), which would let a
   * broken subscription pass.
   */
  test.use({ locale: 'en-IE' })

  /**
   * Covers the switch end to end: the catalog chunk loads, `Intl` follows, and
   * the stored unit values are left alone.
   *
   * It does **not** isolate `useUnitLabels`'s locale subscription — verified by
   * swapping it for the non-reactive `getActiveLocale()` read, which still
   * passes. `preferences.tsx` also calls `useLingui()` for its `t` macros, so
   * the component re-renders on a language change either way. That holds for
   * every formatting component in the app today, which makes the subscription
   * belt-and-braces rather than load-bearing — worth keeping, not worth
   * claiming coverage for.
   */
  test('re-labels the unit rows without a reload', async ({ page }) => {
    await loginViaOidc(page)
    await openLocalizationSettings(page)

    await expect(page.getByTestId('distance-unit')).toHaveText('Metric (km)')

    await page.getByLabel('Language').click()
    await page.getByRole('option', { name: 'Deutsch' }).click()

    await expect(page.getByTestId('distance-unit')).toHaveText('Metrisch (km)')
    // The section heading comes from the catalog rather than Intl, so it proves
    // the catalog chunk loaded and not just that Intl followed the locale.
    await expect(page.getByText('Lokalisierung')).toBeVisible()

    // The unit *values* are unchanged — only their labels are. Switching the UI
    // language must not silently re-derive someone's units.
    await expect(page.getByTestId('temperature-unit')).toHaveText('Celsius (°C)')
  })
})
