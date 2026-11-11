/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Universal proxy client. Hosted mode routes cross-origin requests
 * through `${cloudUrl}/v1/proxy`, mapping caller headers to `X-Proxy-Passthrough-*`.
 * Local mode calls providers directly. Connected web sessions use Hosted mode;
 * Tauri calls upstream via native HTTP with Use Cloud Proxy off, or for loopback
 * targets, and uses Hosted mode for other targets with the toggle on.
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

import type { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import {
  finalUrlHeader,
  passthroughPrefix,
  passthroughPrefixCased,
  proxyFramingHeaders,
  targetUrlHeader,
  wsTargetPrefix,
} from '@shared/proxy-protocol'
import { encodeBase64Url } from '@shared/base64url'
import { encodeWsBearer, wsBearerSubprotocolPrefix, wsCarrierSubprotocol } from '@shared/ws-bearer'
import { appVersionHeader } from './app-version'
import { handleAppVersionUnsupported } from './app-version-unsupported'
import { getAuthToken } from './auth-token'
import { isLoopbackHost } from './mcp-url-validation'
import { isTauri } from './platform'
import { nativeFetch } from './native-fetch'
import { handleSessionRejected } from './session-rejected'
import { usesLocalProviders } from './provider-mode'
import { resolveAbsoluteBackendUrl } from './url-utils'
import { getLocalSetting, isCurrentServer } from '@/stores/local-settings-store'

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

/** Keeps long-lived SDK clients on the current server and direct/proxy mode. */
export const createLiveProxyFetch = (getProxyFetch: () => FetchFn): FetchFn =>
  Object.assign((input: RequestInfo | URL, init?: RequestInit) => getProxyFetch()(input, init), {
    preconnect: () => getProxyFetch().preconnect(),
  })

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
  // These belong on the OUTER request to our backend only — never promote them
  // to passthrough headers, or they would leak to external LLM/MCP upstreams.
  'x-app-version',
  'x-app-language',
])

const buildHostedRequest = (proxyUrl: string, input: RequestInfo | URL, init?: RequestInit): Request => {
  const sourceUrl = input instanceof Request ? input.url : input.toString()
  const sourceHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

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
    // Not inherited from a `Request` input: its browser default ('same-origin') was
    // chosen for the upstream, and this hop goes to our backend, where cookie-only
    // SSO needs the session cookie even when the backend is cross-origin.
    credentials: init?.credentials ?? 'include',
    // This is a fixed backend endpoint, not the upstream hop. A redirect would
    // forward passthrough credentials, which Fetch does not treat as Authorization.
    redirect: 'error',
    signal: init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined,
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

/**
 * Raise the upgrade blocker when the OUTER hop — our backend's version gate —
 * rejected the proxy request.
 *
 * Status alone is not a safe signal on this transport: the proxy relays upstream
 * status codes verbatim, so an external provider answering 426 would otherwise
 * blank the whole app. The caller first excludes responses marked as upstream
 * by the proxy; the envelope then distinguishes our gate from other backend errors.
 * Reads a clone so the response body reaches the caller intact.
 */
const raiseOuterHopVersionBlock = async (response: Response, isCurrent: () => boolean): Promise<void> => {
  if (response.status !== 426) {
    return
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string }
  if (body.code === 'APP_VERSION_UNSUPPORTED' && isCurrent()) {
    handleAppVersionUnsupported(response.status, body)
  }
}

/** Bind proxy credentials to the destination, including equivalent HTTP/WS URLs and trailing slashes. */
const isCurrentProxyServer = (cloudUrl: string): boolean => {
  const selectedServer = getLocalSetting('cloudUrl')
  return (
    isCurrentServer(selectedServer) &&
    resolveAbsoluteBackendUrl(cloudUrl.replace(/^ws/, 'http')) === resolveAbsoluteBackendUrl(selectedServer)
  )
}

export type ProxyFetchOptions = {
  /** Backend URL ending in `/v1`. Empty means no server is configured. */
  cloudUrl: string
  /** When true, attach an Authorization header from this token getter. */
  getProxyAuthToken?: () => string | null
  /** Optional fetch implementation override — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Optional Tauri-detection override — defaults to `isTauri()` from `@/lib/platform`.
   *  Tests pass an explicit boolean to avoid mocking the shared platform module
   *  (which would leak across files; see docs/internals/development/testing.md). */
  isStandalone?: () => boolean
  /** Optional Tauri fetch override — defaults to `@tauri-apps/plugin-http` fetch.
   *  Tests inject a stub. */
  tauriFetch?: typeof tauriFetch
  /** Effective setting getter, read per request. Defaults to computeEffectiveProxyEnabled. */
  getProxyEnabled?: () => boolean
}

/** Build a fetch implementation that hides Hosted/Standalone mode from callers.
 *  Tauri uses native HTTP with Use Cloud Proxy off or for loopback targets.
 *  Web uses direct HTTP in local mode and the backend proxy when connected. */
export const createProxyFetch = (options: ProxyFetchOptions): FetchFn => {
  const isCurrent = () => isCurrentProxyServer(options.cloudUrl)
  const proxyUrl = `${options.cloudUrl.replace(/\/+$/, '')}/proxy`
  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const standalone = (options.isStandalone ?? isTauri)()
    const localProviders = usesLocalProviders(options.cloudUrl)
    const proxyEnabled =
      !localProviders && (options.getProxyEnabled?.() ?? computeEffectiveProxyEnabled(options.isStandalone))
    const targetUrl = input instanceof Request ? input.url : input.toString()
    if (standalone && (!proxyEnabled || isLoopbackHost(new URL(targetUrl).hostname))) {
      return nativeFetch(input, init, options.tauriFetch)
    }

    if (localProviders) {
      return (options.fetchImpl ?? globalThis.fetch)(input, init)
    }

    if (!isCurrent()) {
      throw new DOMException('The selected server changed', 'AbortError')
    }
    const proxyRequest = buildHostedRequest(proxyUrl, input as RequestInfo | URL, init)
    if (options.getProxyAuthToken && !proxyRequest.headers.has('Authorization')) {
      const token = options.getProxyAuthToken()
      if (token) {
        proxyRequest.headers.set('Authorization', `Bearer ${token}`)
      }
    }
    // The outer hop targets `${cloudUrl}/proxy` (our backend), so it carries the
    // app-version header directly. `x-app-version` is in `skipHeaders`, so it is
    // never promoted to a passthrough header bound for the external upstream.
    for (const [key, value] of Object.entries(appVersionHeader())) {
      proxyRequest.headers.set(key, value)
    }
    const f = options.fetchImpl ?? globalThis.fetch
    const proxyResponse = await f(proxyRequest)
    // The backend stamps the final-URL header on every response it relays from an
    // upstream. Only our own backend may trigger app-wide auth or upgrade gates.
    if (isCurrent() && !proxyResponse.headers.has(finalUrlHeader)) {
      await raiseOuterHopVersionBlock(proxyResponse, isCurrent)
      await handleSessionRejected(proxyResponse, isCurrent)
    }
    return unwrapHostedResponse(proxyResponse)
  }
  return Object.assign(proxyFetch, { preconnect: () => Promise.resolve(false) })
}

/** Build a WebSocket constructor that hides Hosted/Standalone mode from callers.
 *
 *  Hosted: connects to `${cloudWsUrl}/proxy/ws` with the bearer token and
 *  target both encoded as `Sec-WebSocket-Protocol` entries (`thunderbolt.v1`,
 *  `thunderbolt.bearer.<token>`, `tbproxy.target.<base64url(url)>`). Browsers
 *  can't attach `Authorization` headers to `new WebSocket()` — the bearer
 *  subprotocol is the only handshake-time channel that doesn't leak via
 *  default request logs (URL/Referer do). The server validates the bearer via
 *  the same signed-bearer path REST uses.
 *
 *  Tauri: follows the same routing as createProxyFetch — direct with Use Cloud Proxy
 *  off (the default), or for loopback targets. With it on, other targets use the hosted path.
 *
 *  Returns a *sync* factory `(url, protocols?) => WebSocket` so callers keep
 *  the synchronous `(url) => WebSocketLike` contract used by the ACP transport.
 *  The bearer token is read synchronously from local storage, so the real
 *  WebSocket is constructed inline — no deferred wrapper is needed. */
export const createProxyWebSocket = (options: {
  cloudUrl: string
  isStandalone?: () => boolean
  /** Test seam — production omits and the factory reads `getAuthToken()`. */
  getAuthToken?: () => string | null
}): ((url: string, protocols?: string[]) => WebSocket) => {
  const standaloneCheck = options.isStandalone ?? isTauri
  const readAuthToken = options.getAuthToken ?? getAuthToken

  return (url: string, protocols?: string[]): WebSocket => {
    const standalone = standaloneCheck()
    if (
      usesLocalProviders(options.cloudUrl) ||
      (standalone && (!computeEffectiveProxyEnabled(standaloneCheck) || isLoopbackHost(new URL(url).hostname)))
    ) {
      return new WebSocket(url, protocols)
    }
    if (!isCurrentProxyServer(options.cloudUrl)) {
      throw new DOMException('The selected server changed', 'AbortError')
    }
    const wsBase = options.cloudUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
    const targetSubprotocol = `${wsTargetPrefix}${encodeBase64Url(url)}`
    const token = readAuthToken()
    const authEntries = token ? [`${wsBearerSubprotocolPrefix}${encodeWsBearer(token)}`] : []
    return new WebSocket(`${wsBase}/proxy/ws`, [
      wsCarrierSubprotocol,
      ...authEntries,
      targetSubprotocol,
      ...(protocols ?? []),
    ])
  }
}
