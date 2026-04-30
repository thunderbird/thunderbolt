/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Returns true when the given URL is hosted on posthog.com or a subdomain
 * (e.g. us.i.posthog.com). Used by mock fetch handlers in tests to filter
 * PostHog analytics requests from other captured fetches.
 */
export const isPosthogRequest = (url: string): boolean => {
  try {
    const { hostname } = new URL(url)
    return hostname === 'posthog.com' || hostname.endsWith('.posthog.com')
  } catch {
    return false
  }
}
