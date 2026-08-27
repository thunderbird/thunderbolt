/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getBrowserLanguages } from '@/i18n'
import { unitDefaultsForRegion } from '@/i18n/region-units'
import { useActiveLocale } from '@/i18n/use-active-locale'
import type { AppLocale } from '@shared/i18n/locales'
import { useEffect, useEffectEvent } from 'react'
import { useSettings } from './use-settings'

/**
 * The region whose conventions the unit defaults follow.
 *
 * Most specific first. The stored country code is an explicit statement of
 * where the user is; a browser tag is a decent proxy (`en-GB` → `GB`); the app
 * locale is the last resort and is the weakest, since the app ships one `en`
 * catalog for every English-speaking region and CLDR maximizes it to `US`.
 */
export const regionForUnitDefaults = (
  countryCode: string | null,
  browserLanguages: readonly string[],
  locale: AppLocale,
): string => {
  if (countryCode) {
    return countryCode
  }
  const tagged = browserLanguages.find((tag) => new Intl.Locale(tag).region)
  return (tagged && new Intl.Locale(tagged).region) || new Intl.Locale(locale).maximize().region || 'US'
}

/**
 * Seeds the unit settings from the user's region the first time they are
 * needed, mirroring `useAppLanguage`'s contract for the `language` setting.
 *
 * Each setting ships as null and is written with `recomputeHash` so it stays a
 * seeded default rather than a user edit — that is what lets reconcile's
 * `wouldOverwriteUserValue` guard preserve it across a `defaultSettingsVersion`
 * bump, and what keeps a later reset meaning "back to auto".
 *
 * Seeding fires only from the shipped null, so two devices with different
 * browser languages cannot ping-pong the synced rows, and a user who has
 * already chosen units never has them overwritten. Changing location afterwards
 * goes through the confirmation dialog in preferences instead.
 *
 * Replaces a pair of authenticated round-trips to `/units`, which meant an
 * offline or not-yet-signed-in first run silently fell back to US defaults
 * whatever the locale said.
 */
export const useUnitDefaults = () => {
  const locale = useActiveLocale()
  const { locationCountryCode, distanceUnit, temperatureUnit, timeFormat, currency } = useSettings({
    location_country_code: '',
    distance_unit: '',
    temperature_unit: '',
    time_format: '',
    currency: '',
  })

  const settings = [distanceUnit, temperatureUnit, timeFormat, currency]
  const canSeed =
    !locationCountryCode.isLoading &&
    settings.every((setting) => !setting.isLoading && !setting.isSaving && !setting.isModified) &&
    settings.some((setting) => setting.rawSetting?.value == null)

  const seedFromRegion = useEffectEvent(() => {
    const region = regionForUnitDefaults(locationCountryCode.rawSetting?.value ?? null, getBrowserLanguages(), locale)
    const defaults = unitDefaultsForRegion(region)
    const writes: Array<[(typeof settings)[number], string]> = [
      [distanceUnit, defaults.distanceUnit],
      [temperatureUnit, defaults.temperatureUnit],
      [timeFormat, defaults.timeFormat],
      [currency, defaults.currency],
    ]
    // Sequential, not `Promise.all`: each `setValue` wraps itself in a
    // transaction, and SQLite rejects a second `begin` while one is open.
    void (async () => {
      for (const [setting, value] of writes) {
        if (setting.rawSetting?.value == null) {
          await setting.setValue(value, { recomputeHash: true })
        }
      }
    })()
  })

  useEffect(() => {
    if (canSeed) {
      seedFromRegion()
    }
  }, [canSeed])
}
