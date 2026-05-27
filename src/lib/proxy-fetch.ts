/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Universal proxy client. Hosted mode (web) routes cross-origin requests
 * through `${cloudUrl}/v1/proxy`, mapping caller headers to `X-Proxy-Passthrough-*`.
 * Standalone mode (Tauri) calls the upstream directly via Tauri's HTTP plugin.
 *
 * The helper hides the difference so call sites — AI SDKs, MCP transports,
 * favicon fetches — look like normal `fetch` calls.
 *
 * e2e-gap: backend e2e suite (`backend/src/proxy/e2e.test.ts`) covers the
 * Hosted-mode proxy contract end-to-end at the API layer. A Playwright spec
 * exercising this from a real browser session is deferred — the existing
 * Playwright config is scoped to SSO flows and adding a general-app spec
 * requires non-trivial sign-in scaffolding.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import {
  passthroughPrefix,
  passthroughPrefixCased,
  proxyFramingHeaders,
  targetUrlHeader,
  wsTargetPrefix,
} from '@shared/proxy-protocol'
import type { HttpClient } from './http'
import { isTauri } from './platform'
import { fetchWsTicket } from './ws-ticket'

/** Carrier subprotocol the client always advertises alongside the ticket. The
 *  proxy WS server echoes this back as `Sec-WebSocket-Protocol` so the upgrade
 *  completes; the ticket entry is consumed server-side and never echoed. */
const proxyWsCarrierSubprotocol = 'thunderbolt.v1'

/** Prefix for the single-use ticket subprotocol entry. */
const proxyWsTicketSubprotocolPrefix = 'thunderbolt.ticket.'

const defaultIsStandalone = isTauri
const defaultReadProxyEnabled = (): string | null =>
  typeof localStorage === 'undefined' ? null : localStorage.getItem('proxy_enabled')

/** Computes whether the cloud proxy is effectively enabled.
 *  Web always proxies (CORS forces it). Tauri respects the `proxy_enabled`
 *  toggle, defaulting to false (direct upstream) when storage is absent. */
export const computeEffectiveProxyEnabled = (
  isStandalone: () => boolean = defaultIsStandalone,
  read: () => string | null = defaultReadProxyEnabled,
): boolean => (isStandalone() ? read() === 'true' : true)

/**
 * Canonical fetch-function shape used across the proxy / AI plumbing.
 *
 * `typeof fetch` is ambiguous in this codebase: Bun's globals declare a
 * `preconnect(url, options): void`, while the DOM lib declares
 * `preconnect(): Promise<boolean>`. Depending on which file TypeScript binds
 * `fetch` to, `typeof fetch` resolves to one shape or the other, causing
 * structural mismatches when a value flows between modules. Pinning to a
 * single `FetchFn` alias keeps the shape consistent across producers and
 * consumers (matches the DOM-lib shape attached to `src/lib/fetch.ts`).
 */
export type FetchFn = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  preconnect: () => Promise<boolean>
}

/** Headers the browser injects automatically and that should never be promoted
 *  to passthrough headers (forwarding them would leak browser context to upstreams
 *  or duplicate the proxy's own framing headers). */
const skipHeaders = new Set([
  'host',
  'origin',
  'referer',
  'user-agent',
  'connection',
  'content-length',
  'transfer-encoding',
  'cookie',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'upgrade-insecure-requests',
])

const buildHostedRequest = (proxyUrl: string, input: RequestInfo | URL, init?: RequestInit): Request => {
  const sourceUrl = input instanceof Request ? input.url : input.toString()
  const sourceHeaders = new Headers(input instanceof Request ? input.headers : init?.headers)

  const proxyHeaders = new Headers()
  proxyHeaders.set(targetUrlHeader, sourceUrl)

  sourceHeaders.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (skipHeaders.has(lower) || lower.startsWith('x-proxy-')) {
      return
    }
    proxyHeaders.set(`${passthroughPrefixCased}${key}`, value)
  })

  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const body = init?.body ?? (input instanceof Request ? (input as Request).body : null)

  return new Request(proxyUrl, {
    method,
    headers: proxyHeaders,
    body: body as BodyInit | null,
    credentials: init?.credentials ?? (input instanceof Request ? input.credentials : 'include'),
    signal: init?.signal,
    // @ts-expect-error -- Bun/Tauri/modern browsers support duplex:'half' for streaming uploads
    duplex: 'half',
  })
}

/** Walk the proxy response, strip the passthrough prefix from response header names,
 *  and rebuild a Response that looks natural to caller code. Passthrough headers
 *  (the upstream's real values) win over the proxy's own framing headers. */
const unwrapHostedResponse = (response: Response): Response => {
  const passthrough = new Headers()
  const fallback = new Headers()
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith(passthroughPrefix)) {
      passthrough.set(lower.slice(passthroughPrefix.length), value)
    } else if (!proxyFramingHeaders.has(lower)) {
      fallback.set(lower, value)
    }
  })
  fallback.forEach((value, key) => {
    if (!passthrough.has(key)) {
      passthrough.set(key, value)
    }
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: passthrough,
  })
}

export type ProxyFetchOptions = {
  /** Cloud (backend) base URL ending in `/v1`, e.g. `http://localhost:8000/v1`. */
  cloudUrl: string
  /** When true, attach an Authorization header from this token getter. */
  getProxyAuthToken?: () => string | null
  /** Optional fetch implementation override — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Optional Tauri-detection override — defaults to `isTauri()` from `@/lib/platform`.
   *  Tests pass an explicit boolean to avoid mocking the shared platform module
   *  (which would leak across files; see docs/development/testing.md). */
  isStandalone?: () => boolean
  /** Optional Tauri fetch override — defaults to `@tauri-apps/plugin-http` fetch.
   *  Tests inject a stub. */
  tauriFetch?: typeof fetch
  /** Effective `proxy_enabled` value. Defaults to `() => true`, which preserves
   *  Hosted-mode (web) behaviour for callers that don't wire the user setting.
   *
   *  Web always proxies (browser CORS forces it — the toggle is disabled in the
   *  UI). Tauri respects the user toggle; when off, requests go upstream-direct
   *  via the Tauri HTTP plugin so the user's IP is hidden from us. Callers that
   *  want to honour the toggle (the React provider and the module-scoped cache
   *  in `src/ai/fetch.ts`) pass a getter that reads the `proxy_enabled` localStorage
   *  key + derives the effective value per platform. */
  getProxyEnabled?: () => boolean
}

/** Build a fetch implementation that hides Hosted/Standalone mode from callers. */
export const createProxyFetch = (options: ProxyFetchOptions): FetchFn => {
  const proxyUrl = `${options.cloudUrl.replace(/\/$/, '')}/proxy`
  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const standalone = (options.isStandalone ?? isTauri)()
    const proxyEnabled = options.getProxyEnabled?.() ?? true
    if (standalone && !proxyEnabled) {
      // Standalone + toggle off: hit the upstream directly through Tauri's HTTP plugin.
      const tFetch = options.tauriFetch ?? (tauriFetch as unknown as typeof fetch)
      return tFetch(input as RequestInfo, init ?? {}) as unknown as Response
    }

    const proxyRequest = buildHostedRequest(proxyUrl, input as RequestInfo | URL, init)
    if (options.getProxyAuthToken && !proxyRequest.headers.has('Authorization')) {
      const token = options.getProxyAuthToken()
      if (token) {
        proxyRequest.headers.set('Authorization', `Bearer ${token}`)
      }
    }
    const f = options.fetchImpl ?? globalThis.fetch
    const proxyResponse = await f(proxyRequest)
    return unwrapHostedResponse(proxyResponse)
  }
  return Object.assign(proxyFetch, { preconnect: () => Promise.resolve(false) })
}

/** Build a WebSocket constructor that hides Hosted/Standalone mode from callers.
 *
 *  Hosted: mints a single-use auth ticket via `POST /v1/ws-ticket` (scope
 *  `proxy`), then connects to `${cloudWsUrl}/proxy/ws` with the ticket and
 *  target both encoded as `Sec-WebSocket-Protocol` entries (`thunderbolt.v1`,
 *  `thunderbolt.ticket.<nonce>`, `tbproxy.target.<base64url(url)>`). Browsers
 *  can't attach `Authorization` headers to `new WebSocket()` — the ticket
 *  subprotocol is the only handshake-time channel that doesn't leak via
 *  default request logs (URL/Referer do).
 *
 *  Standalone: returns a real WebSocket to the upstream URL directly.
 *
 *  Returns a *sync* factory `(url, protocols?) => WebSocket-like` so callers
 *  keep the synchronous `(url) => WebSocketLike` contract used by the ACP
 *  transport. The ticket fetch runs inside the returned object's lifecycle —
 *  listeners are queued until the real WebSocket is constructed, then replayed
 *  in order. This mirrors how the native WebSocket starts in `CONNECTING` and
 *  fires `open` asynchronously, so callers that already use event listeners
 *  see no behavioural difference. */
export const createProxyWebSocket = (options: {
  cloudUrl: string
  isStandalone?: () => boolean
  /** Authenticated HttpClient used to mint single-use proxy WS tickets. Required
   *  for Hosted mode; omitted on Standalone (the standalone branch never hits
   *  the cloud backend). */
  httpClient?: HttpClient
  /** Test seam — production omits and the factory calls `fetchWsTicket`. */
  fetchTicket?: (httpClient: HttpClient) => Promise<string>
}): ((url: string, protocols?: string[]) => WebSocket) => {
  const standaloneCheck = options.isStandalone ?? isTauri
  const fetcher = options.fetchTicket ?? defaultFetchProxyTicket

  return (url: string, protocols?: string[]): WebSocket => {
    const standalone = standaloneCheck()
    if (standalone) {
      return new WebSocket(url, protocols)
    }
    if (!options.httpClient) {
      throw new Error('createProxyWebSocket: httpClient is required for Hosted mode (browser WS ticket auth)')
    }
    const wsBase = options.cloudUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    const targetSubprotocol = `${wsTargetPrefix}${b64UrlEncode(url)}`

    const opener = async (): Promise<WebSocket> => {
      const ticket = await fetcher(options.httpClient!)
      return new WebSocket(`${wsBase}/proxy/ws`, [
        proxyWsCarrierSubprotocol,
        `${proxyWsTicketSubprotocolPrefix}${ticket}`,
        targetSubprotocol,
        ...(protocols ?? []),
      ])
    }
    return createDeferredWebSocket(opener) as unknown as WebSocket
  }
}

const defaultFetchProxyTicket = (httpClient: HttpClient): Promise<string> => fetchWsTicket('proxy', { httpClient })

/** Minimal subset of the native `WebSocket` event surface the ACP transport
 *  uses. Kept local so this file doesn't depend on the transport package. */
type DeferredWsListener = (event: Event) => void

/**
 * Synchronous WebSocket-shaped wrapper around an asynchronously-constructed
 * real WebSocket. Listeners registered before the real socket exists are
 * queued and replayed on the real socket once it resolves; `send()` is
 * buffered until then; `close()` either tears down the future socket or
 * fast-aborts the opener. The wrapper surfaces an `error` event if the opener
 * itself rejects (e.g. ticket fetch fails) so the transport's `connectOnce`
 * rejects with a clear message and the SDK surfaces a transport-open error.
 */
const createDeferredWebSocket = (opener: () => Promise<WebSocket>) => {
  const queuedListeners: Array<{ type: string; listener: DeferredWsListener }> = []
  const pendingSends: string[] = []
  let real: WebSocket | null = null
  let closeRequest: { code?: number; reason?: string } | null = null
  let openerError: Error | null = null

  // Eagerly start the opener so the round-trip overlaps with the caller's
  // listener registration (typical pattern: `factory(url)` then attach
  // 'open'/'error' listeners on the same tick).
  void opener().then(
    (ws) => {
      real = ws
      // Replay listeners in registration order.
      for (const { type, listener } of queuedListeners) {
        ws.addEventListener(type as never, listener as never)
      }
      // Microtask ordering nuance: `new WebSocket(...)` inside the opener may
      // synchronously schedule its own `queueMicrotask` to fire `open` before
      // the surrounding `.then(onResolve)` microtask runs (this is what
      // happens with Bun's test runner + our FakeBrowserSocket). If the inner
      // socket already reached OPEN before we got here, the queued 'open'
      // listeners would have missed the event. Synthesize a synchronous fire
      // so the caller still sees the event exactly once.
      if (ws.readyState === 1) {
        const openEvent = { type: 'open' } as unknown as Event
        for (const { type, listener } of queuedListeners) {
          if (type === 'open') {
            listener(openEvent)
          }
        }
      }
      // Flush queued sends after `open` fires — adding the listener here is
      // OK because at least the original 'open' listener was replayed above.
      const flush = () => {
        for (const data of pendingSends) {
          ws.send(data)
        }
        pendingSends.length = 0
      }
      if (ws.readyState === 1) {
        flush()
      } else {
        ws.addEventListener('open', flush, { once: true })
      }
      // Propagate a pre-resolve close request.
      if (closeRequest) {
        ws.close(closeRequest.code, closeRequest.reason)
      }
    },
    (err) => {
      openerError = err instanceof Error ? err : new Error(String(err))
      // Synthesize an error event for any registered error listener so the
      // transport's `connectOnce` rejects with the same shape it expects from
      // a real socket-error. Schedule on microtask so the caller has time to
      // attach the listener after `factory(url)` returns.
      queueMicrotask(() => {
        const errorListeners = queuedListeners.filter((l) => l.type === 'error')
        const event = { type: 'error', message: openerError?.message } as unknown as Event
        for (const { listener } of errorListeners) {
          listener(event)
        }
      })
    },
  )

  const wrapper = {
    get readyState() {
      return real ? real.readyState : WebSocket.CONNECTING
    },
    send(data: string) {
      if (real && real.readyState === WebSocket.OPEN) {
        real.send(data)
        return
      }
      pendingSends.push(data)
    },
    close(code?: number, reason?: string) {
      if (real) {
        real.close(code, reason)
        return
      }
      closeRequest = { code, reason }
    },
    addEventListener(type: string, listener: DeferredWsListener) {
      if (real) {
        real.addEventListener(type as never, listener as never)
        return
      }
      queuedListeners.push({ type, listener })
    },
    removeEventListener(type: string, listener: DeferredWsListener) {
      if (real) {
        real.removeEventListener(type as never, listener as never)
        return
      }
      const idx = queuedListeners.findIndex((l) => l.type === type && l.listener === listener)
      if (idx >= 0) {
        queuedListeners.splice(idx, 1)
      }
    },
  }
  return wrapper
}

const b64UrlEncode = (text: string): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(text, 'utf-8').toString('base64url')
  }
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
