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

import type { HttpClient } from '@/lib/http'
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
  httpClient: HttpClient,
  appId: string,
  signal?: AbortSignal,
): Promise<MiniAppAuthToken | null> => {
  // The app's client rather than a bare `fetch`: it carries the bearer token and
  // device identity headers, and refreshes on a 401. Building the request by
  // hand skipped all of that, so a token minted just after the session rolled
  // over failed with no way to recover.
  const body = await httpClient
    .post(`mini-apps/${encodeURIComponent(appId)}/token`, { signal })
    .json<MiniAppAuthToken>()
    .catch(() => null)

  return body?.token && body?.expiresAt ? body : null
}
