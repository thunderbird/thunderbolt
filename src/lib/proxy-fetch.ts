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
import { isTauri } from './platform'

/** Headers the browser injects automatically and that should never be promoted
 *  to passthrough headers (forwarding them would leak browser context to upstreams
 *  or duplicate the proxy's own framing headers). */
const SKIP_HEADERS = new Set([
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

const PASSTHROUGH_PREFIX = 'x-proxy-passthrough-'

const buildHostedRequest = (cloudUrl: string, input: RequestInfo | URL, init?: RequestInit): Request => {
  const sourceUrl = input instanceof Request ? input.url : input.toString()
  const sourceHeaders = new Headers(input instanceof Request ? input.headers : init?.headers)

  const proxyHeaders = new Headers()
  proxyHeaders.set('X-Proxy-Target-Url', sourceUrl)

  sourceHeaders.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (SKIP_HEADERS.has(lower)) return
    if (lower.startsWith('x-proxy-')) return
    proxyHeaders.set(`X-Proxy-Passthrough-${key}`, value)
  })

  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const body = init?.body ?? (input instanceof Request ? (input as Request).body : null)

  const proxyUrl = `${cloudUrl.replace(/\/$/, '')}/proxy`
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

/** Walk the proxy response, strip `X-Proxy-Passthrough-` from response header names,
 *  and rebuild a Response that looks natural to caller code. Passthrough headers
 *  (the upstream's real values) win over the proxy's own framing headers. */
const unwrapHostedResponse = (response: Response): Response => {
  const out = new Headers()
  // First pass: collect passthrough headers (the upstream's real values).
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith(PASSTHROUGH_PREFIX)) {
      out.set(lower.slice(PASSTHROUGH_PREFIX.length), value)
    }
  })
  // Second pass: include any unprefixed header that the upstream didn't already
  // send (passthrough wins). Skip proxy-only framing headers.
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith(PASSTHROUGH_PREFIX)) return
    if (lower === 'content-security-policy' || lower === 'content-disposition') return
    if (out.has(lower)) return
    out.set(lower, value)
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
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
}

/** Build a fetch implementation that hides Hosted/Standalone mode from callers. */
export const createProxyFetch = (options: ProxyFetchOptions): typeof fetch =>
  (async (input, init) => {
    const standalone = (options.isStandalone ?? isTauri)()
    if (standalone) {
      // Standalone: hit the upstream directly through Tauri's HTTP plugin.
      const tFetch = options.tauriFetch ?? (tauriFetch as unknown as typeof fetch)
      return tFetch(input as RequestInfo, init ?? {}) as unknown as Response
    }

    const proxyRequest = buildHostedRequest(options.cloudUrl, input as RequestInfo | URL, init)
    if (options.getProxyAuthToken && !proxyRequest.headers.has('Authorization')) {
      const token = options.getProxyAuthToken()
      if (token) proxyRequest.headers.set('Authorization', `Bearer ${token}`)
    }
    const f = options.fetchImpl ?? globalThis.fetch
    const proxyResponse = await f(proxyRequest)
    return unwrapHostedResponse(proxyResponse)
  }) as typeof fetch

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
    const targetSubprotocol = `tbproxy.target.${b64UrlEncode(url)}`
    return new WebSocket(`${wsBase}/proxy/ws`, [targetSubprotocol, ...(protocols ?? [])])
  }

const b64UrlEncode = (text: string): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(text, 'utf-8').toString('base64url')
  }
  // Browser fallback: btoa + url-safe substitutions.
  const b64 = btoa(unescape(encodeURIComponent(text)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
