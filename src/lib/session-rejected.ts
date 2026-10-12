/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAuthToken } from '@/lib/auth-token'

/**
 * Report a session our backend rejected, for backend calls that bypass the
 * HttpClient (chat, voice, the built-in agent). Fires `session_expired`, whose
 * handler also asks whether this device was revoked.
 *
 * Our auth gate pairs 401 with `UNAUTHENTICATED`, so a provider's plain 401 for a bad
 * API key doesn't sign the user out. The body alone can still be forged by an upstream
 * the proxy relays, so the proxy only calls this for responses it didn't relay.
 * Reads a clone so the caller keeps the body.
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
