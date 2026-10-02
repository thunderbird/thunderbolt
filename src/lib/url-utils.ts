/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { deriveFaviconUrl } from '@shared/url'

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

/** Remove only trailing slashes from a backend URL. */
export const normalizeBackendUrl = (url: string): string => url.replace(/\/+$/, '')

/**
 * Resolve a configured backend URL to an absolute one.
 *
 * `VITE_THUNDERBOLT_CLOUD_URL` is a relative path on same-origin deployments
 * (`/v1`, the frontend image's build-arg default) so one image can serve any
 * hostname. It is also editable at runtime from the dev settings page.
 * `fetch` and the OpenAI-compatible clients resolve that against the page
 * themselves, but callers that hand the value to an SDK need an absolute one.
 * An already-absolute value passes through, because `new URL` ignores the base
 * when the first argument is absolute.
 */
export const resolveAbsoluteBackendUrl = (url: string, origin: string = window.location.origin): string =>
  normalizeBackendUrl(new URL(url, origin).toString())
