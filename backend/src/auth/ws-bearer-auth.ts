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
 * `auth.api.getSession({ headers: { Authorization: Bearer <token> }, query: { disableRefresh: true } })`, which
 * runs `bearer({ requireSignature: true })`: HMAC signature check + DB session
 * lookup. The credential works across instances; each process only caches live
 * socket validation briefly and polls the shared session store for revocation.
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

/** Close code 1013 (Try Again Later) for a socket whose bearer could not be checked, for example
 *  because the database is down. The app retries it. 1011 would stop the app from reconnecting
 *  (`terminalCloseCodes` in `src/acp/transports/websocket.ts`). */
export const wsCloseAuthUnavailable = 1013

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

/** Outcome of {@link authorizeWsBearer}: the user, or the code and reason to close the socket with. */
export type WsBearerAuthorization = { ok: true; user: User } | { ok: false; closeCode: number; closeReason: string }

const unauthorized: WsBearerAuthorization = { ok: false, closeCode: wsCloseUnauthorized, closeReason: 'unauthorized' }

/**
 * Resolve and authorize a WebSocket upgrade from its offered subprotocols.
 *
 * Returns the authenticated regular user on success. A missing or invalid
 * bearer, or an anonymous user, gets a 4001 close. Anonymous users must
 * never open a managed-ACP/proxy WebSocket — this preserves the same invariant
 * the REST routes enforce.
 *
 * A session lookup that throws (for example, the database is down) is logged
 * and gets a 1013 close. Letting it reach the route's `open()` would leave the socket
 * open: Elysia catches the rejection and does not close it.
 */
export const authorizeWsBearer = async (
  auth: Auth,
  subprotocolHeader: string | null,
): Promise<WsBearerAuthorization> => {
  const token = extractBearerSubprotocol(subprotocolHeader)
  if (!token) {
    return unauthorized
  }
  try {
    const session = await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
      query: { disableRefresh: true },
    })
    const user = session?.user as User | undefined
    if (!user || user.isAnonymous) {
      return unauthorized
    }
    return { ok: true, user }
  } catch (error) {
    console.error(`WebSocket bearer check failed — ${getSafeLogMessage(error)}`)
    return { ok: false, closeCode: wsCloseAuthUnavailable, closeReason: 'auth unavailable' }
  }
}

type GuardGroup = {
  callbacks: Set<(code: number, reason: string) => void>
  lookup: (force?: boolean) => Promise<WsBearerAuthorization>
  freshLookup: () => Promise<WsBearerAuthorization>
  timer: ReturnType<typeof setInterval>
}

// shortcut: one poll per distinct live bearer per process; add a shared limiter if many live bearers become a load source.
const guardGroups = new WeakMap<Auth, Map<string, GuardGroup>>()

/**
 * The token Better Auth's bearer plugin verifies for a credential: trimmed, and percent-decoded when signed.
 * Keying groups on it keeps every accepted encoding of one bearer in one group, so a session gets one poll.
 */
const canonicalBearer = (token: string) => {
  const trimmed = token.trim()
  if (!trimmed.includes('.') || !trimmed.includes('%')) {
    return trimmed
  }
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

/**
 * Share bearer validation across sockets in this process, including both WebSocket routes. A read that
 * fails (1013) refuses only the handshake that made it; live sockets keep their last result and retry.
 */
export const createWsSessionGuard = (
  auth: Auth,
  subprotocolHeader: string | null,
  reject: (code: number, reason: string) => void,
) => {
  let stopped = false
  const token = canonicalBearer(extractBearerSubprotocol(subprotocolHeader) ?? '')
  const groups = guardGroups.get(auth) ?? new Map<string, GuardGroup>()
  guardGroups.set(auth, groups)
  let group = groups.get(token)
  if (!group) {
    let inFlight: Promise<WsBearerAuthorization> | null = null
    let valid: Extract<WsBearerAuthorization, { ok: true }> | null = null
    let validUntil = 0
    let denied: Extract<WsBearerAuthorization, { ok: false }> | null = null
    let polling = false
    const callbacks = new Set<(code: number, reason: string) => void>()
    const applyResult = (result: WsBearerAuthorization): WsBearerAuthorization => {
      if (denied) {
        return denied
      }
      if (result.ok && valid && result.user.id !== valid.user.id) {
        result = unauthorized
      }
      if (result.ok) {
        valid = result
        validUntil = Date.now() + 1_000
      } else if (result.closeCode === wsCloseAuthUnavailable) {
        // A failed read is not a revocation: keep the last result and retry once the cache window ends.
        validUntil = Date.now() + 1_000
      } else {
        denied = result
        for (const callback of callbacks) {
          callback(result.closeCode, result.closeReason)
        }
      }
      return result
    }
    const freshLookup = () => authorizeWsBearer(auth, subprotocolHeader).then(applyResult)
    const liveLookup = async () => {
      const result = await freshLookup()
      return !result.ok && result.closeCode === wsCloseAuthUnavailable && valid ? valid : result
    }
    const lookup = (force = false): Promise<WsBearerAuthorization> => {
      if (denied) {
        return Promise.resolve(denied)
      }
      if (inFlight) {
        return inFlight
      }
      if (!force && valid && Date.now() < validUntil) {
        return Promise.resolve(valid)
      }
      inFlight = liveLookup().finally(() => {
        inFlight = null
      })
      return inFlight
    }
    const timer = setInterval(() => {
      if (polling) {
        return
      }
      polling = true
      void (async () => {
        try {
          // An inbound lookup started before this tick cannot stand in for the forced poll.
          if (inFlight) {
            await inFlight
          }
          if (callbacks.size > 0) {
            await lookup(true)
          }
        } finally {
          polling = false
        }
      })()
    }, 5_000)
    timer.unref()
    group = { callbacks, lookup, freshLookup, timer }
    groups.set(token, group)
  }
  const currentGroup = group
  currentGroup.callbacks.add(reject)
  return {
    authorize: async () => (stopped ? unauthorized : currentGroup.freshLookup()),
    check: async () => !stopped && (await currentGroup.lookup()).ok && !stopped,
    stop: () => {
      if (stopped) {
        return
      }
      stopped = true
      currentGroup.callbacks.delete(reject)
      if (currentGroup.callbacks.size === 0) {
        clearInterval(currentGroup.timer)
        groups.delete(token)
        if (groups.size === 0) {
          guardGroups.delete(auth)
        }
      }
    },
  }
}
