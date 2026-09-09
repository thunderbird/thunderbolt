/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { matchExactLocale, sourceLocale } from '@shared/i18n/locales'

/**
 * Sent when the app language is absent, not a shipped locale, or English.
 *
 * Matches what the Chrome-on-macOS User-Agent we present would actually send,
 * and keeps English users on precisely the behaviour they have today.
 */
const englishChain = 'en-US,en;q=0.9'

/**
 * Build the `Accept-Language` header to present to a third-party page on behalf
 * of a user, from the `X-App-Language` header their client sent.
 *
 * `pt-BR` → `pt-BR,pt;q=0.9,en;q=0.8`; `de` → `de,en;q=0.9`. English stays on
 * {@link englishChain}, as does anything {@link matchExactLocale} rejects: the
 * value is client-controlled and ends up in an outbound request to a
 * user-supplied URL, so only a tag from the shipped set is ever forwarded.
 *
 * The header cannot translate a page, and that is the point: a URL that names a
 * locale keeps it, and a monolingual page has nothing to negotiate. It only
 * changes URLs that leave the language open, where showing an English card for
 * a page that opens in Portuguese is the thing worth avoiding. Note it follows
 * the *app* language, which deliberately outranks the browser's — so a card can
 * be Japanese for a user whose browser would fetch the page in English.
 *
 * Shipping a regional English catalog (`en-GB`) would need the duplicate `en`
 * rung collapsed below; today `en` is the only shipped tag with an English base.
 *
 * @param appLanguage Raw `X-App-Language` header value, or null/undefined when absent.
 * @returns An `Accept-Language` header value.
 */
export const acceptLanguageFor = (appLanguage: string | null | undefined): string => {
  const locale = matchExactLocale(appLanguage)
  if (!locale) {
    return englishChain
  }
  if (locale === sourceLocale) {
    return englishChain
  }
  const base = new Intl.Locale(locale).language
  return base === locale ? `${locale},en;q=0.9` : `${locale},${base};q=0.9,en;q=0.8`
}
