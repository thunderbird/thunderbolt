/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from '@shared/i18n/locales'
import { matchLocale } from './resolve-locale'

/**
 * The shipped locale most likely spoken in an ISO 3166-1 alpha-2 region, or
 * `null` when the region is unknown or its language isn't one the app ships.
 *
 * Uses CLDR likely subtags (`und-BR` → `pt-Latn-BR`), so this is the dominant
 * language of the region — a heuristic worth confirming with the user, never
 * worth applying silently.
 *
 * Takes a code rather than a country name: the geocoding provider returns one
 * directly, and a display name would have to be reverse-matched against CLDR in
 * whatever language it arrived in. Callers pass that provider code straight
 * through, so the only non-region input to handle is the empty string.
 */
export const localeForRegion = (region: string): AppLocale | null => {
  if (!region) {
    return null
  }
  const { language } = new Intl.Locale(`und-${region}`).maximize()
  return matchLocale(language)
}
