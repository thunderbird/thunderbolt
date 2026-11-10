/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Encode page identities independently of their source URL or artifact reference. */
export const pagePath = (pageId: string) => `/pages/${encodeURIComponent(pageId)}`

/** Only restore app-local routes; a saved return path must never become an external redirect. */
export const pageReturnPath = (state: unknown): string => {
  if (
    state &&
    typeof state === 'object' &&
    'returnTo' in state &&
    typeof state.returnTo === 'string' &&
    /^\/(?!\/|pages\/)/.test(state.returnTo)
  ) {
    return state.returnTo
  }
  return '/chats/new'
}
