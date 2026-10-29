/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Bearer-token authentication for WebSocket upgrades.
 *
 * Browsers can't set an `Authorization` header on `new WebSocket()`. The only
 * handshake-time channels are the URL (logged by every default proxy format and
 * by Referer) and `Sec-WebSocket-Protocol` (logged by none). We carry the same
 * signed bearer token the REST channel uses as a `thunderbolt.bearer.<token>`
 * subprotocol entry and validate it via the identical Better Auth path —
 * `auth.api.getSession({ headers: { Authorization: Bearer <token> } })`, which
 * runs `bearer({ requireSignature: true })`: HMAC signature check + DB session
 * lookup. This is stateless and works across instances; no in-memory store.
 *
 * The bearer entry is consumed in the WS `open()` handler (NOT `beforeHandle`,
 * which Elysia/Bun may invoke more than once per upgrade) and the carrier
 * `thunderbolt.v1` is the only subprotocol echoed back, so the auth-bearing
 * entry never lands on `WebSocket.protocol` or in proxy response logs.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { getSafeLogMessage } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { decodeWsBearer, wsBearerSubprotocolPrefix } from '@shared/ws-bearer'

/** Close code (app-defined 4000–4999 range) emitted when the server accepts the
 *  WebSocket upgrade but then refuses the socket, so the client distinguishes
 *  "the server refused me" (re-login flow) from "I never reached the server"
 *  (network-error toast). */
export const wsCloseUnauthorized = 4001

/**
 * Extract and decode the bearer token from a comma-separated
 * `Sec-WebSocket-Protocol` value. The entry payload is base64url-encoded (the
 * raw bearer contains `.`/`+`/`/`/`=`, which aren't RFC 6455 subprotocol-safe).
 * Returns `null` when no decodable bearer entry is present.
 */
export const extractBearerSubprotocol = (header: string | null): string | null => {
  if (!header) {
    return null
  }
  for (const raw of header.split(',')) {
    const entry = raw.trim()
    if (entry.startsWith(wsBearerSubprotocolPrefix)) {
      return decodeWsBearer(entry.slice(wsBearerSubprotocolPrefix.length))
    }
  }
  return null
}

/**
 * Resolve and authorize a WebSocket upgrade from its offered subprotocols.
 *
 * Returns the authenticated regular user on success, or `null` when the bearer
 * is missing/invalid OR the resolved user is anonymous. Anonymous users must
 * never open a managed-ACP/proxy WebSocket — this preserves the same invariant
 * the REST routes enforce.
 */
export const authorizeWsBearer = async (auth: Auth, subprotocolHeader: string | null): Promise<User | null> => {
  const token = extractBearerSubprotocol(subprotocolHeader)
  if (!token) {
    return null
  }
  const session = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  })
  const user = session?.user as User | undefined
  if (!user || user.isAnonymous) {
    return null
  }
  return user
}

/** Close code (1011) for a socket whose bearer could not be checked because the session lookup threw. */
const wsCloseAuthUnavailable = 1011

/** Outcome of {@link authorizeWsOpen}: the user, or how to close a refused socket. */
export type WsOpenAuthorization = { ok: true; user: User } | { ok: false; closeCode: number; closeReason: string }

/**
 * {@link authorizeWsBearer} for a WebSocket `open()` handler. A missing, invalid or anonymous bearer
 * asks for a 4001 close. A session lookup that throws (the database is down) is logged and asks for
 * a 1011 close: rejecting into Elysia's error handler instead would leave the socket open.
 */
export const authorizeWsOpen = async (auth: Auth, subprotocolHeader: string | null): Promise<WsOpenAuthorization> => {
  try {
    const user = await authorizeWsBearer(auth, subprotocolHeader)
    if (!user) {
      return { ok: false, closeCode: wsCloseUnauthorized, closeReason: 'unauthorized' }
    }
    return { ok: true, user }
  } catch (error) {
    console.error(`WebSocket bearer check failed — ${getSafeLogMessage(error)}`)
    return { ok: false, closeCode: wsCloseAuthUnavailable, closeReason: 'auth unavailable' }
  }
}
