/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Derives a /favicon.ico URL from a page URL's origin. The browser loads it
 * directly — favicons no longer go through the backend proxy.
 *
 * Returns null if the URL is invalid or not HTTPS (we never expose mixed
 * content to the renderer).
 */
export const deriveFaviconUrl = (pageUrl: string): string | null => {
  try {
    const { origin, protocol } = new URL(pageUrl)
    if (protocol !== 'https:') return null
    return `${origin}/favicon.ico`
  } catch {
    return null
  }
}
