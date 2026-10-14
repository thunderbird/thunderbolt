/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const loopbackHostnames = ['localhost', '127.0.0.1', '[::1]']

/**
 * Returns the origin of `override` when it is a loopback URL, else null. Lets a QA build point a third-party API at
 * a local fake, while a misconfigured build can never send user tokens or client secrets to any other host.
 */
export const loopbackOrigin = (override: string | undefined): string | null => {
  const url = override && URL.canParse(override) ? new URL(override) : null
  return url && loopbackHostnames.includes(url.hostname) ? url.origin : null
}

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
    if (protocol !== 'https:') {
      return null
    }
    return `${origin}/favicon.ico`
  } catch {
    return null
  }
}
