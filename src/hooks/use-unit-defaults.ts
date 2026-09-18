/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { updateSettings } from '@/dal'
import { getBrowserLanguages } from '@/i18n'
import { unitDefaultsForRegion } from '@/i18n/region-units'
import { useActiveLocale } from '@/i18n/use-active-locale'
import type { Setting } from '@/types'
import type { AppLocale } from '@shared/i18n/locales'
import { useEffect, useEffectEvent } from 'react'
import { useSettings } from './use-settings'

/** The region subtag of a BCP-47 tag, or `null` if the tag is malformed. */
const regionOfTag = (tag: string, { maximize = false } = {}): string | null => {
  try {
    const locale = new Intl.Locale(tag)
    return (maximize ? locale.maximize().region : locale.region) ?? null
  } catch {
    return null
  }
}

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
  // `Intl.Locale` throws `RangeError` on a malformed tag, and `navigator.languages`
  // is not guaranteed well-formed (underscore and `#Hans` variants show up in the
  // wild). A throw here escapes the seeding effect and takes down the tree, for a
  // value that has a fallback two lines down — so parse defensively and skip.
  const fromBrowser = browserLanguages.map((tag) => regionOfTag(tag)).find(Boolean)
  return fromBrowser || regionOfTag(locale, { maximize: true }) || 'US'
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
  const db = useDatabase()
  const { locationCountryCode, distanceUnit, temperatureUnit, timeFormat, currency } = useSettings({
    location_country_code: '',
    distance_unit: '',
    temperature_unit: '',
    time_format: '',
    currency: '',
  })

  /**
   * Unset *and* untouched. Judged per setting rather than across the group: a
   * user who picks a currency by hand should still get the other three seeded.
   */
  const isUnseeded = (setting: { rawSetting: Setting | null; isModified: boolean }) =>
    setting.rawSetting?.value == null && !setting.isModified

  const units = [
    ['distance_unit', distanceUnit] as const,
    ['temperature_unit', temperatureUnit] as const,
    ['time_format', timeFormat] as const,
    ['currency', currency] as const,
  ]

  const canSeed =
    !locationCountryCode.isLoading &&
    units.every(([, setting]) => !setting.isLoading && !setting.isSaving) &&
    units.some(([, setting]) => isUnseeded(setting))

  const seedFromRegion = useEffectEvent(() => {
    const region = regionForUnitDefaults(locationCountryCode.rawSetting?.value ?? null, getBrowserLanguages(), locale)
    const defaults = unitDefaultsForRegion(region)
    const valueFor = {
      distance_unit: defaults.distanceUnit,
      temperature_unit: defaults.temperatureUnit,
      time_format: defaults.timeFormat,
      currency: defaults.currency,
    }

    // `updateSettings` takes the whole record and wraps it in one transaction.
    // Writing them one at a time would both fail (SQLite rejects a `begin`
    // inside an open transaction, so `Promise.all` loses all but the first) and
    // risk leaving half a region's conventions behind.
    void updateSettings(
      db,
      Object.fromEntries(units.filter(([, setting]) => isUnseeded(setting)).map(([key]) => [key, valueFor[key]])),
      { recomputeHash: true },
    )
  })

  useEffect(() => {
    if (canSeed) {
      seedFromRegion()
    }
  }, [canSeed])
}
