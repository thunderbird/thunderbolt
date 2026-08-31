/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for the locale set, shared by `lingui.config.ts`
 * (extraction/compilation) and the frontend runtime in `src/i18n`. Lives in
 * `shared/` rather than `src/` so that the backend can validate the
 * `X-App-Language` header against the same list once it starts reading it — it
 * cannot import from `src/`. Kept free of runtime imports so the Lingui CLI can
 * load it outside Vite.
 */

/** Locales the app ships catalogs for. `en` is the source locale; `en-XA` is the CI pseudo-locale. */
export const appLocales = ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'en-XA'] as const

export type AppLocale = (typeof appLocales)[number]

export const sourceLocale: AppLocale = 'en'

export const pseudoLocale: AppLocale = 'en-XA'

/**
 * A locale's language named in English — "German", "Brazilian Portuguese".
 *
 * For model-facing prompt text, so it asks CLDR in `en` rather than in the locale
 * itself (contrast `endonym` in `src/i18n/language-options.ts`, which names each
 * language in itself for the picker). CLDR's exact wording is ICU-version dependent
 * — "Brazilian Portuguese" on one build, "Portuguese (Brazil)" on another — which is
 * fine here and would not be in the UI: the reader is a model, and both name the same
 * language. Don't pin the phrasing in an assertion.
 *
 * The pseudo-locale is named as plain English: CLDR calls it "English
 * (Pseudo-Accents)", which describes the glyph mangling rather than a language to
 * answer in.
 */
export const englishLanguageName = (locale: AppLocale): string =>
  new Intl.DisplayNames(['en'], { type: 'language' }).of(locale === pseudoLocale ? sourceLocale : locale) ?? locale
