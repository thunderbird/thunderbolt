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

/**
 * True for an absolute http(s) URL.
 *
 * Operator config that reaches an `href` or `<iframe src>` (mini app URLs,
 * branding links) is checked with this on both ends: the backend refuses to
 * publish anything else, and the client refuses to render it, because the
 * backend a client talks to is a local setting. A `javascript:` value would
 * otherwise execute in our page.
 *
 * @param value - Candidate URL string, from operator config or the wire.
 */
export const isHttpUrl = (value: string): boolean => hasProtocol(value, 'http:') || hasProtocol(value, 'https:')

/** The message both ends attach to a failed {@link isHttpUrl} check. */
export const httpUrlMessage = 'must be an http(s) URL'

/**
 * True for an absolute URL with the given scheme.
 *
 * @param value - Candidate URL string.
 * @param protocol - The scheme with its colon, e.g. `https:` or `mailto:`.
 */
export const hasProtocol = (value: string, protocol: string): boolean =>
  URL.canParse(value) && new URL(value).protocol === protocol
