/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isSafeRelativePath } from './safe-relative-path'

/** Accept an app route, never an external URL or another OAuth callback. */
export const parseOAuthReturnPath = (path: unknown): `/${string}` | null => {
  if (
    typeof path !== 'string' ||
    !isSafeRelativePath(path) ||
    path.includes('\\') ||
    [...path].some((character) => character.charCodeAt(0) <= 32)
  ) {
    return null
  }
  const url = new URL(path, 'https://app.thunderbolt.io')
  if (url.origin !== 'https://app.thunderbolt.io' || url.pathname.startsWith('/oauth/')) {
    return null
  }
  return `${url.pathname}${url.search}${url.hash}` as `/${string}`
}

/** Restore a valid app route, falling back to Connections for missing or invalid state. */
export const oauthReturnPath = (path: unknown): `/${string}` => parseOAuthReturnPath(path) ?? '/settings/connections'

/** Capture the current route before leaving the app for authorization. */
export const currentOAuthReturnPath = () =>
  oauthReturnPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
