/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Fetching Mini App identity tokens from the backend.
 *
 * Split out of the bridge because it is the one part of the handshake that
 * leaves the browser, and because the bridge shouldn't grow a dependency on
 * auth headers and cloud URLs to do postMessage plumbing.
 */

import { getAuthenticatedHeaders } from '@/lib/auth-token'
import type { MiniAppAuthToken } from '@shared/mini-app-protocol'

/**
 * Ask the backend for a token scoped to one app.
 *
 * Returns null rather than throwing on any failure. A Mini App that can't get
 * an identity is a degraded app, not a broken host: the frame still loads, the
 * bridge still works, and the guest is told `auth: false` so it can say
 * something honest instead of retrying into a wall.
 */
export const fetchMiniAppToken = async (
  cloudUrl: string,
  appId: string,
  signal?: AbortSignal,
): Promise<MiniAppAuthToken | null> => {
  const response = await fetch(`${cloudUrl}/mini-apps/${encodeURIComponent(appId)}/token`, {
    method: 'POST',
    headers: getAuthenticatedHeaders(),
    credentials: 'include',
    signal,
  }).catch(() => null)

  if (!response?.ok) {
    return null
  }

  const body = (await response.json().catch(() => null)) as MiniAppAuthToken | null
  return body?.token && body?.expiresAt ? body : null
}
