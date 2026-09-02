/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for the locale set, shared by `lingui.config.ts`
 * (extraction/compilation) and the frontend runtime in `src/i18n`. Lives in
 * `shared/` rather than `src/` so that the backend can validate the
 * `X-App-Language` header against the same list — which it now does, in
 * `backend/src/emails/i18n.ts`; it cannot import from `src/`. Kept free of
 * runtime imports so the Lingui CLI can load it outside Vite.
 */

/** Locales the app ships catalogs for. `en` is the source locale; `en-XA` is the CI pseudo-locale. */
export const appLocales = ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'en-XA'] as const

export type AppLocale = (typeof appLocales)[number]

export const sourceLocale: AppLocale = 'en'

export const pseudoLocale: AppLocale = 'en-XA'
