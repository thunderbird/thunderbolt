/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { isPrivateAddress } from '@/utils/url-validation'
import { Elysia, type AnyElysia } from 'elysia'
import { noopObservability, type ObservabilityRecorder } from './observability'

const TARGET_PREFIX = 'tbproxy.target.'

const QUEUE_BYTES = 256 * 1024
const QUEUE_MESSAGES = 64

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

export type ParsedSubprotocol =
  | { ok: true; target: string; callerProtocols: string[] }
  | { ok: false; reason: 'missing' | 'duplicate' | 'malformed' }

/** Parse the inbound `Sec-WebSocket-Protocol` header looking for the target marker. */
export const parseTargetSubprotocol = (header: string | null): ParsedSubprotocol => {
  if (!header) return { ok: false, reason: 'missing' }
  const protocols = header
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const targets = protocols.filter((p) => p.startsWith(TARGET_PREFIX))
  if (targets.length === 0) return { ok: false, reason: 'missing' }
  if (targets.length > 1) return { ok: false, reason: 'duplicate' }
  const encoded = targets[0].slice(TARGET_PREFIX.length)
  let target: string
  try {
    target = Buffer.from(encoded, 'base64url').toString('utf-8')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!target) return { ok: false, reason: 'malformed' }
  // Strip *all* tbproxy.* entries — the namespace is reserved for proxy control.
  const callerProtocols = protocols.filter((p) => !p.startsWith('tbproxy.'))
  return { ok: true, target, callerProtocols }
}

export type ValidatedTarget =
  | { ok: true; target: URL }
  | { ok: false; reason: 'invalid-url' | 'wss-only' | 'private-host' }

/** Validate the decoded target URL. Hostname-only SSRF — DNS rebinding gap is documented. */
export const validateWsTarget = (raw: string): ValidatedTarget => {
  let target: URL
  try {
    target = new URL(raw)
  } catch {
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
  return { ok: true, target }
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
  if (typeof msg === 'string') return Buffer.byteLength(msg, 'utf-8')
  if (msg instanceof Uint8Array) return msg.byteLength
  return msg.byteLength
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
    if (options.rateLimit) g.use(options.rateLimit)

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
        let bytesIn = 0
        let bytesOut = 0
        let observedTargetUrl = ''
        let observedClose: { code: number; reason?: string } | null = null
        const userId = (ws.data as { user?: { id?: string } }).user?.id ?? 'unknown'
        const requestId = crypto.randomUUID()
        const finalize = () => {
          if (!observedClose) return
          observability.proxyWsRelay({
            method: 'WS',
            target_url: observedTargetUrl,
            close_code: observedClose.code,
            duration_ms: Math.round(performance.now() - startedAt),
            user_id: userId,
            request_id: requestId,
            bytes_in: bytesIn,
            bytes_out: bytesOut,
            ...(observedClose.reason ? { error: observedClose.reason } : {}),
          })
          observedClose = null
        }
        ;(ws.data as { __observe?: () => void }).__observe = finalize
        ;(ws.data as { __recordClose?: (code: number, reason?: string) => void }).__recordClose = (code, reason) => {
          observedClose = { code, reason }
        }
        ;(ws.data as { __recordIn?: (n: number) => void }).__recordIn = (n) => {
          bytesIn += n
        }
        ;(ws.data as { __recordOut?: (n: number) => void }).__recordOut = (n) => {
          bytesOut += n
        }
        ;(ws.data as { __setTarget?: (url: string) => void }).__setTarget = (url) => {
          observedTargetUrl = url
        }

        const headers = (ws.data as { headers?: Record<string, string | undefined> | Headers }).headers
        const subprotocolHeader =
          headers instanceof Headers
            ? headers.get('sec-websocket-protocol')
            : (headers?.['sec-websocket-protocol'] ?? null)
        const parsed = parseTargetSubprotocol(subprotocolHeader)
        if (!parsed.ok) {
          ws.close(wsCloseCodes.invalidSubprotocol, parsed.reason)
          return
        }
        const validated = validateWsTarget(parsed.target)
        if (!validated.ok) {
          const code = validated.reason === 'wss-only' ? wsCloseCodes.schemeRejected : wsCloseCodes.invalidSubprotocol
          ws.close(code, validated.reason)
          return
        }

        const state: RelayState = {
          upstream: null,
          upstreamReady: false,
          pending: [],
          pendingBytes: 0,
          closing: false,
        }
        ;(ws.data as { relay?: RelayState }).relay = state
        ;(ws.data as { __setTarget?: (url: string) => void }).__setTarget?.(validated.target.toString())

        let upstream: WebSocket
        try {
          upstream = wsFactory(validated.target.toString(), parsed.callerProtocols)
        } catch (err) {
          ws.close(wsCloseCodes.internalError, err instanceof Error ? err.message : 'connect failed')
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
          if (state.closing) return
          state.closing = true
          try {
            ws.close(event.code || 1000, event.reason || '')
          } catch {
            // already closed
          }
        })

        upstream.addEventListener('error', () => {
          if (state.closing) return
          state.closing = true
          try {
            ws.close(wsCloseCodes.internalError, 'upstream error')
          } catch {
            // already closed
          }
        })
      },
      message(ws, message) {
        const state = (ws.data as { relay?: RelayState }).relay
        if (!state) return
        if (state.closing) return

        // Coerce Elysia's parsed message back to bytes / string for forwarding.
        // Elysia auto-parses by content-type; we want the raw payload.
        const payload =
          typeof message === 'string' || message instanceof ArrayBuffer || message instanceof Uint8Array
            ? message
            : new TextEncoder().encode(typeof message === 'object' ? JSON.stringify(message) : String(message))

        if (state.upstreamReady && state.upstream) {
          state.upstream.send(payload as never)
          return
        }

        // Queue while upstream is still connecting.
        const bytes = messageByteLength(payload)
        if (state.pending.length + 1 > QUEUE_MESSAGES || state.pendingBytes + bytes > QUEUE_BYTES) {
          state.closing = true
          try {
            state.upstream?.close(1000)
          } catch {
            // ignore
          }
          try {
            ws.close(wsCloseCodes.queueOverflow, 'pre-connect queue overflow')
          } catch {
            // ignore
          }
          return
        }
        state.pending.push(payload)
        state.pendingBytes += bytes
      },
      close(ws, code, reason) {
        ;(ws.data as { __recordClose?: (code: number, reason?: string) => void }).__recordClose?.(code, reason)
        ;(ws.data as { __observe?: () => void }).__observe?.()
        const state = (ws.data as { relay?: RelayState }).relay
        if (!state) return
        state.closing = true
        if (state.upstream && state.upstream.readyState === state.upstream.OPEN) {
          try {
            state.upstream.close(code || 1000, reason || '')
          } catch {
            // ignore
          }
        } else if (state.upstream && state.upstream.readyState === state.upstream.CONNECTING) {
          // Native WebSocket has no .abort(); .close() during connect is well-defined.
          try {
            state.upstream.close()
          } catch {
            // ignore
          }
        }
      },
    })
  })
}
