/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Localization for transactional email (THU-824) — the four templates in this
 * directory are the main place the backend authors user-facing prose. Most
 * other responses return a code the client translates at its display boundary,
 * though a few still carry English `message` text (the 429 in
 * `@/waitlist/routes` is rendered verbatim by the client); THU-824 does not
 * cover those.
 *
 * The templates use the plain `@lingui/core` runtime (`i18n._({ id })`) rather
 * than the Lingui macros the frontend uses. Bun has no Babel pass, so a macro
 * import resolves to Lingui's stub and throws when called — and because
 * `shouldSkipEmail()` returns true whenever `RESEND_API_KEY` is unset (the
 * usual dev setup) or `NODE_ENV === 'test'`, the send helpers are skipped in
 * exactly the environments where you would notice. `render.test.tsx` renders
 * the templates directly and would catch a macro there, but nothing covers the
 * send helpers, so `backend/eslint.config.js` bans the macro specifiers
 * outright. Extraction is unaffected: `@lingui/babel-plugin-extract-messages`
 * matches `i18n._` by identifier name, so the runtime calls land in the catalog
 * too.
 */

import { setupI18n, type I18n, type Messages } from '@lingui/core'
import { matchExactLocale, sourceLocale, type AppLocale } from '@shared/i18n/locales'
import { messages as de } from './locales/de/messages'
import { messages as en } from './locales/en/messages'
import { messages as enXA } from './locales/en-XA/messages'
import { messages as es } from './locales/es/messages'
import { messages as fr } from './locales/fr/messages'
import { messages as ja } from './locales/ja/messages'
import { messages as ptBR } from './locales/pt-BR/messages'

const catalogs: Record<AppLocale, Messages> = {
  en,
  de,
  fr,
  es,
  'pt-BR': ptBR,
  ja,
  'en-XA': enXA,
}

const instances = new Map<AppLocale, I18n>()

/**
 * The `I18n` instance for a locale, built from the compiled email catalog.
 *
 * One instance per locale rather than a module-global `i18n.activate()`: the
 * backend serves concurrent requests, so a single mutable active locale would
 * let one request's language leak into another's email. Memoized per locale,
 * mirroring `getFormatters` in `src/i18n/format.ts`.
 */
export const getEmailI18n = (locale: AppLocale): I18n => {
  const existing = instances.get(locale)
  if (existing) {
    return existing
  }
  const created = setupI18n({ locale, messages: { [locale]: catalogs[locale] } })
  instances.set(locale, created)
  return created
}

/**
 * The locale to render an email in, from the recipient's `X-App-Language`.
 *
 * Every client sets that header on every backend request (`src/lib/http.ts`,
 * `src/lib/auth-token.ts`, `src/contexts/auth-context.tsx`), and all four
 * transactional emails are sent inside a request made by the recipient's own
 * client — including the three whose recipients have no `user` row yet, which
 * is why the header rather than a persisted column is the source of truth.
 *
 * The header carries a tag the client already negotiated, so {@link
 * matchExactLocale} validates rather than re-negotiates: an unshipped tag
 * renders English rather than being widened to its base language. Its set
 * excludes `en-XA`, which matters here even though `getEmailI18n` still renders
 * it — the preview server and the render tests pass the pseudo-locale directly,
 * so nothing legitimate needs it to arrive over the wire, while
 * `/v1/waitlist/join` is unauthenticated and takes the recipient from the
 * request body, so honouring it would let anyone mail a third party
 * pseudo-localized gibberish.
 *
 * @param tag The raw `X-App-Language` value, or null/undefined when the send
 *   has no request behind it — then the source locale is used.
 */
export const resolveEmailLocale = (tag: string | null | undefined): AppLocale => matchExactLocale(tag) ?? sourceLocale
