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
import { isTauri } from './platform'

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
 *  Hosted: connects to `${cloudWsUrl}/proxy/ws` with the target encoded in the
 *  Sec-WebSocket-Protocol header as `tbproxy.target.<base64url(url)>`.
 *  Standalone: returns a real WebSocket to the upstream URL directly. */
export const createProxyWebSocket =
  (options: { cloudUrl: string; isStandalone?: () => boolean }) =>
  (url: string, protocols?: string[]): WebSocket => {
    const standalone = (options.isStandalone ?? isTauri)()
    if (standalone) {
      return new WebSocket(url, protocols)
    }
    const wsBase = options.cloudUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    const targetSubprotocol = `${wsTargetPrefix}${b64UrlEncode(url)}`
    return new WebSocket(`${wsBase}/proxy/ws`, [targetSubprotocol, ...(protocols ?? [])])
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
