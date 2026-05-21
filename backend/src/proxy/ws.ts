/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { isPrivateAddress } from '@/utils/url-validation'
import { Elysia, type AnyElysia } from 'elysia'
import { noopObservability, type ObservabilityRecorder, type ProxyErrorType } from './observability'

const targetPrefix = 'tbproxy.target.'

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
  const callerProtocols = protocols.filter((p) => !p.startsWith('tbproxy.'))
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
 *  can stub the upstream connection. */
export const createUniversalProxyWsRoutes = (
  auth: Auth,
  options: {
    /** Override the WebSocket constructor used to open the upstream connection.
     *  Defaults to `globalThis.WebSocket`. Tests inject an in-process stub. */
    wsFactory?: (url: string, protocols?: string[]) => WebSocket
    rateLimit?: AnyElysia
    observability?: ObservabilityRecorder
  } = {},
) => {
  const wsFactory = options.wsFactory ?? ((url, protocols) => new WebSocket(url, protocols))
  const observability = options.observability ?? noopObservability

  return new Elysia({ name: 'universal-proxy-ws' }).use(createAuthMacro(auth)).guard({ auth: true }, (g) => {
    if (options.rateLimit) {
      g.use(options.rateLimit)
    }

    return g.ws('/proxy/ws', {
      beforeHandle({ request, set }) {
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

        // Echo back a chosen subprotocol so strict WS clients (Bun, browsers)
        // see the offer was accepted. Prefer a caller protocol; fall back to
        // the tbproxy marker so the server response is never empty when the
        // client offered any protocols.
        const chosen = parsed.callerProtocols[0] ?? subprotocolHeader?.split(',')[0]?.trim()
        if (chosen) {
          set.headers['sec-websocket-protocol'] = chosen
        }
      },
      open(ws) {
        const startedAt = performance.now()
        const extras = wsExtras(ws)
        const userId = extras.user?.id ?? 'unknown'
        const requestId = crypto.randomUUID()
        let observedClose: { code: number; reason?: string } | null = null

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
  })
}
