/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appLocales, pseudoLocale, sourceLocale, type AppLocale } from './locales'

/** Locales eligible for browser-language negotiation — every shipped locale except the CI pseudo-locale. */
export const negotiableLocales = appLocales.filter((locale) => locale !== pseudoLocale)

const isAppLocale = (value: string): value is AppLocale => (appLocales as readonly string[]).includes(value)

const baseOf = (tag: string): string => tag.toLowerCase().split('-')[0]

/**
 * Match a single BCP-47 tag against the negotiable locale set.
 * Tries an exact (case-insensitive) match first, then falls back to the
 * base language: `pt-PT` → `pt-BR`, `de-AT` → `de`, `en-GB` → `en`.
 */
const matchBrowserLanguage = (tag: string): AppLocale | null => {
  const lowered = tag.toLowerCase()
  const exact = negotiableLocales.find((locale) => locale.toLowerCase() === lowered)
  if (exact) {
    return exact
  }
  const base = baseOf(tag)
  return negotiableLocales.find((locale) => baseOf(locale) === base) ?? null
}

/**
 * Resolve the active app locale. Pure so it's unit-testable.
 *
 * Order: explicit supported setting → first `navigator.languages` entry that
 * matches the supported set (exact tag, then base language) → `'en'`.
 * The `en-XA` pseudo-locale is honored as an explicit setting (dev/CI) but
 * never offered through browser negotiation.
 */
export const resolveLocale = (setting: string | null, browserLanguages: readonly string[]): AppLocale => {
  if (setting && isAppLocale(setting)) {
    return setting
  }
  for (const tag of browserLanguages) {
    const match = matchBrowserLanguage(tag)
    if (match) {
      return match
    }
  }
  return sourceLocale
}
