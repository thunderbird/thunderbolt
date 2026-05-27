/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Fetch a single-use WebSocket-handshake ticket from the cloud backend. The
 * caller passes the returned nonce as the second subprotocol on the
 * `new WebSocket(...)` constructor (the first is the carrier `thunderbolt.v1`).
 * The server burns the ticket on consumption and echoes only the carrier
 * subprotocol back, so the auth-bearing entry never appears on
 * `WebSocket.protocol`.
 *
 * See backend/src/auth/ws-ticket-store.ts for the design rationale (Slack
 * RTM 30 s, single-use, opaque-nonce pattern).
 */

import type { HttpClient } from '@/lib/http'

/** Scope literals that the backend recognises (mirror of WsTicketScope on the server). */
export type WsTicketScope = 'haystack' | 'proxy'

export type WsTicketResponse = {
  ticket: string
  expiresAt: number
}

export type FetchWsTicketDeps = {
  /** Authenticated client created via `createAuthenticatedClient(cloudUrl, ...)`. */
  httpClient: HttpClient
}

/**
 * POST to `/v1/ws-ticket` and return the nonce. Throws via {@link HttpError}
 * on 401/403/4xx/5xx — the caller surfaces the failure as a transport-open
 * error so the SDK rejects with a clear "auth ticket fetch failed" reason.
 *
 * `httpClient` is required (no implicit global) because cloud-URL resolution
 * happens at app-init time via `createAuthenticatedClient(cloudUrl, ...)` —
 * callers thread the same instance they already use for everything else.
 */
export const fetchWsTicket = async (scope: WsTicketScope, deps: FetchWsTicketDeps): Promise<string> => {
  const response = await deps.httpClient.post('ws-ticket', { json: { scope } }).json<WsTicketResponse>()
  return response.ticket
}
