/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAuthToken } from '@/lib/auth-token'

/**
 * Report a session our backend rejected, for backend calls that bypass the
 * HttpClient (chat, voice, the built-in agent). Fires `session_expired`, whose
 * handler also asks whether this device was revoked.
 *
 * Status alone is not enough: the proxy relays upstream statuses verbatim, so a
 * provider's 401 for a bad API key must not sign the user out. Only our auth gate
 * pairs 401 with `UNAUTHENTICATED`. Reads a clone so the caller keeps the body.
 */
export const handleSessionRejected = async (response: Response): Promise<void> => {
  if (response.status !== 401 || !getAuthToken()) {
    return
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: string } | null
  if (body?.code === 'UNAUTHENTICATED') {
    // Event name kept in sync with src/db/powersync/connector.ts; importing it would cycle.
    window.dispatchEvent(new CustomEvent('powersync_credentials_invalid', { detail: { reason: 'session_expired' } }))
  }
}
