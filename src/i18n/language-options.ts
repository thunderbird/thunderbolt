/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { pseudoLocale, type AppLocale } from '@shared/i18n/locales'
import { settableLocales } from './resolve-locale'

/** Each language named in itself, so the list reads naturally whatever the active UI language is. */
const endonym = (locale: AppLocale): string => {
  const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
}

/**
 * The selectable UI languages.
 *
 * Derived from `settableLocales` rather than re-deriving the dev-build rule, so
 * the picker cannot offer a locale the resolver would refuse — the two used to
 * disagree, which is how the pseudo-locale reached production devices.
 */
export const languageOptions: ReadonlyArray<{ value: string; label: string }> = settableLocales.map((locale) => ({
  value: locale,
  label: locale === pseudoLocale ? 'Pseudo-locale (en-XA)' : endonym(locale),
}))

/** The endonym for a locale tag, falling back to the tag itself. */
export const languageLabel = (locale: string): string =>
  languageOptions.find((option) => option.value === locale)?.label ?? locale
