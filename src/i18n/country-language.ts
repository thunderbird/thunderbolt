/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from './locales'
import { matchLocale } from './resolve-locale'

/**
 * Normalize a country name for matching: case, accents, and punctuation vary
 * between the geocoding provider and CLDR ("Côte d'Ivoire" vs "Cote d Ivoire").
 */
const normalize = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const allRegionCodes = (): string[] => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  return letters.flatMap((first) => letters.map((second) => first + second))
}

/**
 * Deprecated codes share a display name with their replacement ("FX" and "FR"
 * are both "France") but carry no useful likely-subtags, so collapse each code
 * onto the region CLDR canonicalizes it to.
 */
const canonicalRegion = (code: string): string => new Intl.Locale(`und-${code}`).maximize().region ?? code

/**
 * English country name → ISO 3166-1 alpha-2, built from CLDR region display
 * names. `Intl.DisplayNames#of` echoes the input back for codes it doesn't
 * know, which is how unassigned codes are filtered out. There is no `Intl`
 * API to enumerate regions, so the 676-code space is swept once and memoized.
 *
 * English is the right lookup language: the backend pins `language=en` on the
 * geocoding request, so country names always arrive in English.
 */
let countryCodesByName: Map<string, string> | null = null

const getCountryCodesByName = (): Map<string, string> => {
  if (countryCodesByName) {
    return countryCodesByName
  }
  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
  countryCodesByName = new Map(
    allRegionCodes().flatMap((code) => {
      const name = displayNames.of(code)
      return !name || name === code ? [] : [[normalize(name), canonicalRegion(code)] as const]
    }),
  )
  return countryCodesByName
}

/**
 * Resolve a country name to its ISO 3166-1 alpha-2 code, or `null` when the
 * name isn't a CLDR region name.
 */
export const countryCodeFromName = (countryName: string): string | null =>
  getCountryCodesByName().get(normalize(countryName)) ?? null

/**
 * The shipped locale most likely spoken in a country, or `null` when the
 * country is unknown or its language isn't one the app ships.
 *
 * Uses CLDR likely subtags (`und-BR` → `pt-Latn-BR`), so this is the dominant
 * language of the region — a heuristic worth confirming with the user, never
 * worth applying silently.
 */
export const localeForCountry = (countryName: string): AppLocale | null => {
  const code = countryCodeFromName(countryName)
  if (!code) {
    return null
  }
  return matchLocale(new Intl.Locale(`und-${code}`).maximize().language)
}
