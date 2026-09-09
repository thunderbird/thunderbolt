/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from '@shared/i18n/locales'
import { resolveLocale } from './resolve-locale'

/**
 * localStorage mirror of the resolved locale.
 *
 * The authoritative value is the PowerSync-synced `language` setting, but it
 * arrives asynchronously — `useSettings` is a watched SQLite query, so for the
 * first stretch of every page load it still reads the shipped default. Requests
 * that fire in that window (the PowerSync token request most of all) would
 * otherwise send `X-App-Language: en` for a user who picked Japanese. The
 * mirror is the only store readable synchronously at import time; the synced
 * setting still wins the moment it hydrates.
 */
const localeStorageKey = 'thunderbolt_locale'

const readStoredLocale = (): string | null =>
  typeof localStorage === 'undefined' ? null : localStorage.getItem(localeStorageKey)

/** The subset of `navigator` this module reads — a test/DI seam. */
type LanguageSource = { languages?: readonly string[]; language?: string }

/**
 * Browser language preferences, most preferred first.
 *
 * Empty outside a browser. Bun defines a `navigator` carrying only `userAgent`,
 * so the non-browser case has to be detected from the language fields being
 * absent rather than from `navigator` itself — this module is imported at boot
 * by `src/lib/http.ts`, which the Bun-run eval entrypoint pulls in, and
 * `[undefined]` there would crash `resolveLocale`.
 *
 * @param source Language source; defaults to the ambient `navigator`.
 */
export const getBrowserLanguages = (
  source: LanguageSource | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): readonly string[] => {
  if (!source) {
    return []
  }
  if (source.languages?.length) {
    return source.languages
  }
  return source.language ? [source.language] : []
}

/**
 * The locale a page load starts from: the mirror if there is one, otherwise
 * browser negotiation, otherwise `en`. Treating the mirror as the "explicit
 * setting" argument is deliberate — it is a copy of the synced setting, so it
 * should outrank `navigator.languages` exactly as the original does.
 */
export const readInitialLocale = (): AppLocale => resolveLocale(readStoredLocale(), getBrowserLanguages())

// Seeded at import so the first request of a page load already carries the
// user's locale instead of the shipped default.
let activeLocale: AppLocale = readInitialLocale()

/**
 * The locale the app is currently operating in.
 *
 * For non-React callers that need the value synchronously — the
 * `X-App-Language` header in `src/lib/http.ts` and `src/lib/auth-token.ts`.
 * Lingui's `i18n.locale` is not a substitute: it reports the *loaded catalog*,
 * so it trails a locale switch by a chunk fetch and would disagree with the
 * header the app is already sending.
 */
export const getActiveLocale = (): AppLocale => activeLocale

const listeners = new Set<() => void>()

/**
 * Subscribe to locale changes. Pairs with {@link getActiveLocale} as a
 * `useSyncExternalStore` store, for render paths that must recompute when the
 * locale changes — see `useActiveLocale`.
 *
 * @param listener Called after each change.
 * @returns Unsubscribe function.
 */
export const subscribeActiveLocale = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const publish = (locale: AppLocale): void => {
  if (locale === activeLocale) {
    return
  }
  activeLocale = locale
  listeners.forEach((listener) => listener())
}

/**
 * Record the locale the app switched to and mirror it for the next boot.
 * Called by `activateLocale` — the single writer — before it awaits the
 * catalog chunk, so a request issued right after a language change carries the
 * new tag rather than the one whose catalog is still loading.
 */
export const setActiveLocale = (locale: AppLocale): void => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(localeStorageKey, locale)
  }
  publish(locale)
}

/**
 * Drop the mirror and fall back to browser negotiation.
 *
 * Called from `clearLocalData` when the settings database is cleared: the mirror
 * caches a value from that database, so once it is gone the mirror is stale and
 * would boot the next identity in the previous account's language. Deliberately
 * *not* called when the caller keeps the database — the retained `language` row
 * still matches the mirror, and clearing it would only flash the browser
 * language before that row hydrates.
 */
export const clearActiveLocale = (): void => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(localeStorageKey)
  }
  publish(readInitialLocale())
}
