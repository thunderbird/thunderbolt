/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appLocales, matchExactLocale, negotiableLocales, sourceLocale, type AppLocale } from '@shared/i18n/locales'

/**
 * Locales an explicit `language` setting is allowed to select.
 *
 * `language` is a **synced** setting, so a value chosen on one device reaches
 * all of them. The picker only offers the pseudo-locale in dev builds, but on
 * its own that gate is cosmetic: a developer selecting it would sync `en-XA` to
 * their own production devices, where the UI renders pseudo-text and the picker
 * shows an empty trigger because no option matches it. Refusing the value here
 * is what actually contains it — the setting then falls through to browser
 * negotiation like any other unsupported tag.
 */
export const settableLocales: readonly AppLocale[] = import.meta.env.DEV ? appLocales : negotiableLocales

const isSettableLocale = (value: string): value is AppLocale => (settableLocales as readonly string[]).includes(value)

const baseOf = (tag: string): string => tag.toLowerCase().split('-')[0]

/**
 * Match a single BCP-47 tag against the negotiable locale set, or `null` when
 * the app ships no catalog for it. Tries an exact (case-insensitive) match
 * first, then falls back to the base language: `pt-PT` → `pt-BR`, `de-AT` →
 * `de`, `en-GB` → `en`.
 */
export const matchLocale = (tag: string): AppLocale | null => {
  const exact = matchExactLocale(tag)
  if (exact) {
    return exact
  }
  const base = baseOf(tag)
  return negotiableLocales.find((locale) => baseOf(locale) === base) ?? null
}

/**
 * Resolve the active app locale. Pure so it's unit-testable.
 *
 * Order: explicit settable setting → first `navigator.languages` entry that
 * matches the supported set (exact tag, then base language) → `'en'`.
 * The `en-XA` pseudo-locale is honored as an explicit setting in dev builds
 * only (see {@link settableLocales}), and never offered through browser
 * negotiation in any build.
 */
export const resolveLocale = (setting: string | null, browserLanguages: readonly string[]): AppLocale => {
  if (setting && isSettableLocale(setting)) {
    return setting
  }
  for (const tag of browserLanguages) {
    const match = matchLocale(tag)
    if (match) {
      return match
    }
  }
  return sourceLocale
}
