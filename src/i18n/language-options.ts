/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { pseudoLocale } from './locales'
import { negotiableLocales } from './resolve-locale'

/**
 * The selectable UI languages, labelled as endonyms (each language named in
 * itself, via `Intl.DisplayNames`) so the list reads naturally whatever the
 * active UI language is. The `en-XA` pseudo-locale is offered in dev builds only.
 */
export const languageOptions: ReadonlyArray<{ value: string; label: string }> = [
  ...negotiableLocales.map((locale) => {
    const endonym = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
    return {
      value: locale as string,
      label: endonym.charAt(0).toLocaleUpperCase(locale) + endonym.slice(1),
    }
  }),
  ...(import.meta.env.DEV ? [{ value: pseudoLocale as string, label: 'Pseudo-locale (en-XA)' }] : []),
]

/** The endonym for a locale tag, falling back to the tag itself. */
export const languageLabel = (locale: string): string =>
  languageOptions.find((option) => option.value === locale)?.label ?? locale
