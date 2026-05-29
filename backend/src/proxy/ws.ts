/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { authorizeWsBearer } from '@/auth/ws-bearer-auth'
import { isPrivateAddress } from '@/utils/url-validation'
import { Elysia, type AnyElysia } from 'elysia'
import { noopObservability, type ObservabilityRecorder, type ProxyErrorType } from './observability'

const targetPrefix = 'tbproxy.target.'

/**
 * Carrier subprotocol the client advertises alongside the bearer. Echoed back
 * so RFC 6455 strict clients (browsers, Bun) accept the upgrade. Stripped from
 * caller protocols before forwarding upstream so it never leaks past the relay.
 */
const wsCarrierSubprotocol = 'thunderbolt.v1'

/**
 * Close code emitted when the WebSocket upgrade succeeds but auth fails. We
 * deliberately open the socket and then close with 4001 (app-defined 4000–4999
 * range) so the client distinguishes "the server refused me" from "I never
 * reached the server" — the former triggers a re-login flow, the latter a
 * network-error toast. Mirrors the Haystack route.
 */
const wsCloseUnauthorized = 4001

const queueBytes = 256 * 1024
const queueMessages = 64

/** Close codes used by the relay. */
export const wsCloseCodes = {
  /** Internal upstream error or upstream connection failed unexpectedly. */
  internalError: 1011,
  /** Subprotocol parsing/encoding error or non-wss target. */
  invalidSubprotocol: 4002,
  /** Target URL has a scheme other than wss://. */
  schemeRejected: 4003,
  /** Pre-connect message queue exceeded byte or message budget. */
  queueOverflow: 4008,
} as const

/** Map a downstream-observed close code to a categorical proxy error.
 *  Returns undefined for benign closes (1000 / 1001) and upstream-propagated
 *  codes the proxy can't safely categorise — these emit without `error_type`,
 *  the same way HTTP 2xx/3xx responses do on the routes path. */
export const classifyWsCloseCode = (code: number): ProxyErrorType | undefined => {
  if (code === wsCloseCodes.invalidSubprotocol || code === wsCloseCodes.schemeRejected) {
    return 'invalid_target'
  }
  if (code === wsCloseCodes.queueOverflow) {
    return 'cap_exceeded'
  }
  if (code === wsCloseCodes.internalError) {
    return 'upstream_5xx'
  }
  return undefined
}

export type ParsedSubprotocol =
  | { ok: true; target: string; callerProtocols: string[] }
  | { ok: false; reason: 'missing' | 'duplicate' | 'malformed' }

/** Decode a `tbproxy.target.<base64url>` entry to its raw target URL.
 *  Returns null if the payload is empty or not valid base64url. */
const decodeTargetEntry = (entry: string): string | null => {
  const encoded = entry.slice(targetPrefix.length)
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8')
    return decoded || null
  } catch {
    return null
  }
}

/** Parse the inbound `Sec-WebSocket-Protocol` header looking for the target marker. */
export const parseTargetSubprotocol = (header: string | null): ParsedSubprotocol => {
  if (!header) {
    return { ok: false, reason: 'missing' }
  }
  const protocols = header
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const targets = protocols.filter((p) => p.startsWith(targetPrefix))
  if (targets.length === 0) {
    return { ok: false, reason: 'missing' }
  }
  if (targets.length > 1) {
    return { ok: false, reason: 'duplicate' }
  }
  const target = decodeTargetEntry(targets[0])
  if (!target) {
    return { ok: false, reason: 'malformed' }
  }
  // Strip *all* tbproxy.* entries — the namespace is reserved for proxy control.
  // Also strip `thunderbolt.*` (carrier `thunderbolt.v1` and bearer
  // `thunderbolt.bearer.<token>`) — these are server-side auth plumbing and
  // must never leak to the upstream handshake.
  const callerProtocols = protocols.filter((p) => !p.startsWith('tbproxy.') && !p.startsWith('thunderbolt.'))
  return {
    ok: true,
    target,
    callerProtocols,
  }
}

export type ValidatedTarget =
  | { ok: true; target: URL }
  | { ok: false; reason: 'invalid-url' | 'wss-only' | 'private-host' }

/** Best-effort URL parse. Returns null instead of throwing. */
const tryParseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** Validate the decoded target URL. Hostname-only SSRF — DNS rebinding gap is documented. */
export const validateWsTarget = (raw: string): ValidatedTarget => {
  const target = tryParseUrl(raw)
  if (!target) {
    return { ok: false, reason: 'invalid-url' }
  }
  if (target.protocol !== 'wss:') {
    return { ok: false, reason: 'wss-only' }
  }
  const hostname = target.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: 'private-host' }
  }
  if (isPrivateAddress(hostname)) {
    return { ok: false, reason: 'private-host' }
  }
  return {
    ok: true,
    target,
  }
}

/** Per-connection state attached to ws.data. */
type RelayState = {
  upstream: WebSocket | null
  upstreamReady: boolean
  /** Messages received from the downstream client while upstream was still connecting. */
  pending: Array<string | ArrayBuffer | Uint8Array>
  pendingBytes: number
  closing: boolean
}

const messageByteLength = (msg: string | ArrayBuffer | Uint8Array): number => {
  if (typeof msg === 'string') {
    return Buffer.byteLength(msg, 'utf-8')
  }
  if (msg instanceof Uint8Array) {
    return msg.byteLength
  }
  return msg.byteLength
}

const sharedEncoder = new TextEncoder()

export type WsConnectArgs = { targetUrl: string; callerProtocols: string[] }

/** Per-connection state stashed on `ws.data`. Elysia's WS context type doesn't
 *  surface these fields, so we keep one cast site here and consume via a typed
 *  accessor below. */
type WsExtras = {
  user?: { id?: string }
  headers?: Record<string, string | undefined> | Headers
  connectArgs?: WsConnectArgs
  relay?: RelayState
  observe?: () => void
  recordClose?: (code: number, reason?: string) => void
}

const wsExtras = (ws: { data: unknown }): WsExtras => ws.data as WsExtras

/** Re-derive connect args from the inbound headers when the beforeHandle cache is missing. */
const deriveConnectArgs = (extras: WsExtras): WsConnectArgs | null => {
  const headers = extras.headers
  const subprotocolHeader =
    headers instanceof Headers ? headers.get('sec-websocket-protocol') : (headers?.['sec-websocket-protocol'] ?? null)
  const parsed = parseTargetSubprotocol(subprotocolHeader)
  if (!parsed.ok) {
    return null
  }
  const validated = validateWsTarget(parsed.target)
  if (!validated.ok) {
    return null
  }
  return { targetUrl: validated.target.toString(), callerProtocols: parsed.callerProtocols }
}

const safeWsClose = (ws: { close: (code?: number, reason?: string) => void }, code?: number, reason?: string) => {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

/** Open the upstream WebSocket. Returns null and closes downstream on failure. */
const openUpstream = (
  wsFactory: (url: string, protocols?: string[]) => WebSocket,
  targetUrl: string,
  callerProtocols: string[],
  downstream: { close: (code?: number, reason?: string) => void },
): WebSocket | null => {
  try {
    return wsFactory(targetUrl, callerProtocols)
  } catch (err) {
    downstream.close(wsCloseCodes.internalError, err instanceof Error ? err.message : 'connect failed')
    return null
  }
}

/** Build the relay routes plugin. The websocket factory is injected so tests
 *  can stub the upstream connection.
 *
 *  Auth: browsers can't attach `Authorization` headers or cross-site cookies
 *  to `new WebSocket()`. We carry the same signed bearer token the REST channel
 *  uses as a `Sec-WebSocket-Protocol: thunderbolt.bearer.<token>` entry and
 *  validate it inside `open(ws)` (not `beforeHandle` — Elysia/Bun invokes
 *  `beforeHandle` more than once per upgrade in some paths) via the identical
 *  Better Auth path (HMAC signature + DB session lookup). Anonymous users are
 *  rejected. The carrier `thunderbolt.v1` is echoed in `upgrade(...)`
 *  (idempotent header set); the bearer entry is never echoed so it doesn't land
 *  on `WebSocket.protocol` or in proxy logs. */
export const createUniversalProxyWsRoutes = (options: {
  /** Better Auth instance used to validate the bearer subprotocol. */
  auth: Auth
  /** Override the WebSocket constructor used to open the upstream connection.
   *  Defaults to `globalThis.WebSocket`. Tests inject an in-process stub. */
  wsFactory?: (url: string, protocols?: string[]) => WebSocket
  rateLimit?: AnyElysia
  observability?: ObservabilityRecorder
}) => {
  const { auth } = options
  const wsFactory = options.wsFactory ?? ((url, protocols) => new WebSocket(url, protocols))
  const observability = options.observability ?? noopObservability

  const plugin = new Elysia({ name: 'universal-proxy-ws' })
  if (options.rateLimit) {
    plugin.use(options.rateLimit)
  }

  return plugin.ws('/proxy/ws', {
    upgrade({ request, set }) {
      // Echo the carrier subprotocol so strict WS clients (browsers, Bun)
      // accept the upgrade. Idempotent — setting the same response header
      // twice has no observable effect, which keeps us safe if Elysia ever
      // invokes `upgrade()` more than once per attempt. The auth-bearing
      // ticket entry is intentionally NOT echoed: keeping it off the
      // response header means it never lands on `WebSocket.protocol` (page
      // JS) or in proxy response logs.
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      const offered = subprotocolHeader?.split(',').map((entry) => entry.trim()) ?? []
      if (offered.includes(wsCarrierSubprotocol)) {
        set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
        return
      }
      // Fall back to the first non-thunderbolt/tbproxy caller protocol so
      // legacy clients that don't advertise the carrier still complete the
      // handshake. This branch is retained for compatibility with the
      // pre-ticket transport and the e2e tests that exercise it.
      const chosen = offered.find((p) => !p.startsWith('thunderbolt.') && !p.startsWith('tbproxy.'))
      if (chosen) {
        set.headers['sec-websocket-protocol'] = chosen
      }
    },
    beforeHandle({ request, set }) {
      // Sync, idempotent validations only — single-use state (the ticket) is
      // consumed in `open()` because Elysia/Bun can invoke beforeHandle more
      // than once per upgrade.
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      const parsed = parseTargetSubprotocol(subprotocolHeader)
      if (!parsed.ok) {
        set.status = 400
        return `Invalid Sec-WebSocket-Protocol: ${parsed.reason}`
      }
      const validated = validateWsTarget(parsed.target)
      if (!validated.ok) {
        set.status = 400
        return `Invalid target URL: ${validated.reason}`
      }
    },
    async open(ws) {
      const startedAt = performance.now()
      const extras = wsExtras(ws)
      const requestId = crypto.randomUUID()
      let observedClose: { code: number; reason?: string } | null = null

      // Validate the bearer exactly once per accepted socket. The bearer rides
      // a `thunderbolt.bearer.<token>` subprotocol entry (browsers can't set
      // `Authorization` on `new WebSocket()`); it is verified via the same
      // Better Auth path REST uses (HMAC + DB lookup). Anonymous users are
      // rejected — they must never open a proxy WebSocket.
      const data = ws.data as unknown as { request?: Request }
      const subprotocolHeader = data.request?.headers.get('sec-websocket-protocol') ?? null
      const user = await authorizeWsBearer(auth, subprotocolHeader)
      if (!user) {
        ws.close(wsCloseUnauthorized, 'unauthorized')
        return
      }
      const userId = user.id

      const connectArgs = deriveConnectArgs(extras)
      if (!connectArgs) {
        ws.close(wsCloseCodes.invalidSubprotocol, 'invalid')
        return
      }
      const targetUrl = connectArgs.targetUrl

      extras.observe = () => {
        if (!observedClose) {
          return
        }
        const errorType = classifyWsCloseCode(observedClose.code)
        observability.proxyWsRelay({
          method: 'WS',
          target_url: targetUrl,
          close_code: observedClose.code,
          duration_ms: Math.round(performance.now() - startedAt),
          user_id: userId,
          request_id: requestId,
          ...(errorType ? { error_type: errorType } : {}),
          ...(observedClose.reason ? { error: observedClose.reason } : {}),
        })
        observedClose = null
      }
      extras.recordClose = (code, reason) => {
        observedClose = { code, reason }
      }

      const state: RelayState = {
        upstream: null,
        upstreamReady: false,
        pending: [],
        pendingBytes: 0,
        closing: false,
      }
      extras.relay = state

      const upstream = openUpstream(wsFactory, targetUrl, connectArgs.callerProtocols, ws)
      if (!upstream) {
        return
      }
      state.upstream = upstream

      upstream.addEventListener('open', () => {
        if (state.closing) {
          upstream.close(1000)
          return
        }
        state.upstreamReady = true
        for (const msg of state.pending) {
          upstream.send(msg as never)
        }
        state.pending = []
        state.pendingBytes = 0
      })

      upstream.addEventListener('message', (event: MessageEvent) => {
        try {
          ws.send(event.data as never)
        } catch {
          // downstream gone; nothing to do
        }
      })

      upstream.addEventListener('close', (event: CloseEvent) => {
        if (state.closing) {
          return
        }
        state.closing = true
        safeWsClose(ws, event.code || 1000, event.reason || '')
      })

      upstream.addEventListener('error', () => {
        if (state.closing) {
          return
        }
        state.closing = true
        safeWsClose(ws, wsCloseCodes.internalError, 'upstream error')
      })
    },
    message(ws, message) {
      const state = wsExtras(ws).relay
      if (!state) {
        return
      }
      if (state.closing) {
        return
      }

      // Coerce Elysia's parsed message back to bytes / string for forwarding.
      // Elysia auto-parses by content-type; we want the raw payload.
      const payload =
        typeof message === 'string' || message instanceof ArrayBuffer || message instanceof Uint8Array
          ? message
          : sharedEncoder.encode(typeof message === 'object' ? JSON.stringify(message) : String(message))

      if (state.upstreamReady && state.upstream) {
        state.upstream.send(payload as never)
        return
      }

      // Queue while upstream is still connecting.
      const bytes = messageByteLength(payload)
      if (state.pending.length + 1 > queueMessages || state.pendingBytes + bytes > queueBytes) {
        state.closing = true
        if (state.upstream) {
          safeWsClose(state.upstream, 1000)
        }
        safeWsClose(ws, wsCloseCodes.queueOverflow, 'pre-connect queue overflow')
        return
      }
      state.pending.push(payload)
      state.pendingBytes += bytes
    },
    close(ws, code, reason) {
      const extras = wsExtras(ws)
      extras.recordClose?.(code, reason)
      extras.observe?.()
      const state = extras.relay
      if (!state) {
        return
      }
      state.closing = true
      if (state.upstream && state.upstream.readyState === state.upstream.OPEN) {
        safeWsClose(state.upstream, code || 1000, reason || '')
      } else if (state.upstream && state.upstream.readyState === state.upstream.CONNECTING) {
        // Native WebSocket has no .abort(); .close() during connect is well-defined.
        safeWsClose(state.upstream)
      }
    },
  })
}
