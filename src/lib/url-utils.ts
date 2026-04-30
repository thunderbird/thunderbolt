/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Validates that a URL uses a safe protocol (http or https).
 * Returns false for javascript:, data:, and other potentially dangerous schemes.
 */
export const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Derives a /favicon.ico URL from a page URL's origin. Pure helper — does not
 * proxy. Callers that need a CORS-friendly URL should pass the result through
 * `useProxyUrl()` from `@/lib/proxy-url`.
 *
 * @returns The raw favicon URL, or null if `pageUrl` is invalid.
 */
export const deriveFaviconUrl = (pageUrl: string): string | null => {
  try {
    const { origin } = new URL(pageUrl)
    return `${origin}/favicon.ico`
  } catch {
    return null
  }
}
