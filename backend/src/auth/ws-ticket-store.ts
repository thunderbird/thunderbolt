/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * In-memory single-use ticket store for WebSocket-handshake authentication.
 *
 * Why this exists: browsers can't set custom headers on `new WebSocket()`. The
 * only handshake-time channels are the URL (logged by every default proxy
 * format and by Referer) and the `Sec-WebSocket-Protocol` header (logged by
 * none by default). We mint short-lived, single-use, server-stored tickets via
 * an authenticated `POST /v1/ws-ticket`, the client passes them as a
 * subprotocol entry on connect, and `WS /v1/haystack/ws` consumes them.
 *
 * Pattern references: Slack `rtm.connect` (30s, single-use, URL-bound),
 * Heroku canonical ticket doc, AWS API Gateway $connect authorizer flows.
 * Opaque-nonce + server-stored is chosen over signed/stateless because
 * single-use enforcement is the threat model goal here.
 */
export type WsTicketScope = 'haystack'

type StoredTicket = {
  userId: string
  scope: WsTicketScope
  expiresAt: number
}

export type WsTicketStore = {
  /** Mint a ticket for the user+scope. Returns the opaque nonce the client sends. */
  issueTicket: (userId: string, scope: WsTicketScope, ttlMs: number) => string
  /** Consume a ticket. Returns `{ userId }` on the single allowed use, `null` otherwise (expired, unknown, scope mismatch, already consumed). */
  consumeTicket: (ticket: string, scope: WsTicketScope) => { userId: string } | null
  /** Reset the store. For tests only. */
  clearForTesting: () => void
  /** Stop the cleanup interval. For tests / graceful shutdown. */
  shutdown: () => void
  /** Active ticket count. For tests / observability. */
  size: () => number
}

export type WsTicketStoreOptions = {
  /** Hard upper bound on active tickets. Tickets above this get refused. Default 10_000. */
  maxActive?: number
  /** Cleanup sweep interval. Default 10s. */
  sweepIntervalMs?: number
  /** Time provider — `Date.now()` in prod, fake in tests. */
  now?: () => number
  /** When true (the default), `.unref()` the interval so it never blocks process exit / test runner shutdown. */
  unrefInterval?: boolean
}

const defaultMaxActive = 10_000
const defaultSweepIntervalMs = 10_000

/**
 * Build a ticket store. Production callers use the module-level singleton via
 * {@link getWsTicketStore}; tests construct an isolated instance to avoid
 * cross-suite leakage.
 */
export const createWsTicketStore = (options: WsTicketStoreOptions = {}): WsTicketStore => {
  const maxActive = options.maxActive ?? defaultMaxActive
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs
  const now = options.now ?? Date.now
  const unrefInterval = options.unrefInterval ?? true

  const tickets = new Map<string, StoredTicket>()

  const sweep = (): void => {
    const cutoff = now()
    for (const [nonce, stored] of tickets) {
      if (stored.expiresAt <= cutoff) {
        tickets.delete(nonce)
      }
    }
  }

  const interval = setInterval(sweep, sweepIntervalMs)
  if (unrefInterval && typeof (interval as { unref?: () => void }).unref === 'function') {
    ;(interval as { unref: () => void }).unref()
  }

  const issueTicket = (userId: string, scope: WsTicketScope, ttlMs: number): string => {
    if (tickets.size >= maxActive) {
      // Opportunistic sweep; if still full, refuse — the DoS guard. The caller
      // surfaces this as a 503 so the client can retry after a short wait.
      sweep()
      if (tickets.size >= maxActive) {
        throw new WsTicketStoreFullError()
      }
    }
    const nonce = generateNonce()
    tickets.set(nonce, { userId, scope, expiresAt: now() + ttlMs })
    return nonce
  }

  const consumeTicket = (ticket: string, scope: WsTicketScope): { userId: string } | null => {
    const stored = tickets.get(ticket)
    if (!stored) {
      return null
    }
    // Delete first to guarantee single-use even if the scope/expiry check below fails.
    tickets.delete(ticket)
    if (stored.scope !== scope) {
      return null
    }
    if (stored.expiresAt <= now()) {
      return null
    }
    return { userId: stored.userId }
  }

  const clearForTesting = (): void => {
    tickets.clear()
  }

  const shutdown = (): void => {
    clearInterval(interval)
  }

  return {
    issueTicket,
    consumeTicket,
    clearForTesting,
    shutdown,
    size: () => tickets.size,
  }
}

/** Thrown by `issueTicket` when the store is at capacity. Surfaces as 503 at the route. */
export class WsTicketStoreFullError extends Error {
  constructor() {
    super('ws ticket store at capacity')
    this.name = 'WsTicketStoreFullError'
  }
}

/** Cryptographically secure base64url nonce. 32 bytes ≈ 256 bits of entropy, ≈43 chars unpadded. */
const generateNonce = (): string => {
  // Bun supports node:crypto; using the Web Crypto API would also work but
  // `randomBytes` is the most direct path and matches Better-Auth's own usage.
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

const base64UrlEncode = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) {
    s += String.fromCharCode(b)
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Module-level singleton for production. Tests should NOT touch this — they
// build their own store via `createWsTicketStore` (or inject one).
let singleton: WsTicketStore | null = null

/** Production accessor — lazy singleton so a missing env var at import time doesn't crash test imports. */
export const getWsTicketStore = (options?: WsTicketStoreOptions): WsTicketStore => {
  if (!singleton) {
    singleton = createWsTicketStore(options)
  }
  return singleton
}

/** Reset the module singleton. For tests that exercise the production accessor. */
export const resetWsTicketStoreSingleton = (): void => {
  singleton?.shutdown()
  singleton = null
}
