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
import { miniAppAuthTokenSchema, type MiniAppAuthToken } from '@shared/mini-app-protocol'

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
  try {
    const body = await httpClient.post(`mini-apps/${encodeURIComponent(appId)}/token`, { signal }).json<unknown>()
    const parsed = miniAppAuthTokenSchema.safeParse(body)
    if (!parsed.success) {
      // Parsed rather than cast: `.json<MiniAppAuthToken>()` asserts a shape it
      // never checks, so `{ token: 7 }` sailed through and the guest received a
      // number where it expected a JWS.
      console.error(`[mini-apps] ${appId}: token response was not a token`, parsed.error.issues)
      return null
    }
    return parsed.data
  } catch (error) {
    /*
     * Logged, not swallowed.
     *
     * Two of the failures here are configuration rather than weather — a 403
     * for a disallowed origin or an anonymous session, and a 426 from the
     * app-version gate. Returning null for all of them told the guest
     * `auth: false`, which is the right *answer* but left nothing anywhere
     * saying why a correctly-built app never got an identity.
     *
     * An abort is the exception: unmounting mid-mint is routine, and the frame
     * is already gone.
     */
    if (signal?.aborted) {
      return null
    }
    console.error(`[mini-apps] ${appId}: could not mint an identity token`, error)
    return null
  }
}
