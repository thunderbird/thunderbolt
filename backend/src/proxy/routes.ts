/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { validateAndPin } from '@/utils/url-validation'
import { Elysia, type AnyElysia } from 'elysia'
import { capStream } from './streaming'
import { noopObservability, type ObservabilityRecorder } from './observability'

const maxBodyBytes = 10 * 1024 * 1024
const maxHops = 5
const dnsTimeoutMs = 5_000
const streamCapBytes = 10 * 1024 * 1024
const streamIdleMs = 30_000

const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const bodylessMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The prefix carriers symmetric headers across the proxy boundary in both directions. */
const PASSTHROUGH_PREFIX = 'x-proxy-passthrough-'

/**
 * Wire-level / hop-by-hop response headers the proxy never propagates. The proxy
 * hands a fresh body to the client, so any framing/encoding/length headers from
 * upstream describe the wrong thing. Set-Cookie family is dropped to preserve
 * cookie isolation: the response's *origin* is Thunderbolt, not the upstream.
 */
const droppedResponseHeaders = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'upgrade',
  'set-cookie',
  'set-cookie2',
])

/** Race a promise against a DNS timeout. Throws `Error('DNS_TIMEOUT')` on expiry.
 *  Note: dns.promises.lookup does not honor an AbortSignal in Node 22, so this only
 *  unblocks the handler — the underlying lookup runs to completion in background. */
const withDnsTimeout = <T>(p: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), dnsTimeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Printable ASCII guard — rejects CRLF and control characters. */
const isPrintableAscii = (value: string) => /^[\x20-\x7E]*$/.test(value)

/** Auto-upgrade `http://` URLs to `https://` and reject all other non-https schemes. */
const normaliseTargetUrl = (raw: string): URL | { error: string } => {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { error: 'Invalid URL' }
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:'
  }
  if (parsed.protocol !== 'https:') {
    return { error: 'Only http:// or https:// targets are allowed' }
  }
  return parsed
}

/** Strip the X-Proxy-Passthrough- prefix off inbound headers and validate values.
 *  Returns the assembled outbound headers, or a string error message. Callers that
 *  receive `false` for `dropAuthorization` keep `Authorization` intact (same-origin
 *  redirects); callers that pass `true` strip it (cross-origin redirects). */
const buildOutboundHeaders = (
  inbound: Headers,
  { dropAuthorization }: { dropAuthorization: boolean } = { dropAuthorization: false },
): Headers | { error: string } => {
  const out = new Headers()
  let invalid = false
  inbound.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!lower.startsWith(PASSTHROUGH_PREFIX)) return
    const upstreamKey = lower.slice(PASSTHROUGH_PREFIX.length)
    if (!upstreamKey) return
    if (!isPrintableAscii(value)) {
      invalid = true
      return
    }
    if (dropAuthorization && upstreamKey === 'authorization') return
    out.set(upstreamKey, value)
  })
  if (invalid) return { error: 'Invalid passthrough header value' }
  return out
}

/** Re-prefix every upstream response header so the browser ignores them and the
 *  caller's `proxyFetch` helper unwraps them back into a normal-looking Response. */
const buildResponseHeaders = (upstream: Headers, finalUrl: string): Headers => {
  const out = new Headers()
  upstream.forEach((value, key) => {
    if (droppedResponseHeaders.has(key.toLowerCase())) return
    out.set(`X-Proxy-Passthrough-${key}`, value)
  })

  // Proxy-set headers (NOT prefixed): these describe the proxy's own response framing
  // and security posture. Forced — override anything the upstream might have sent.
  out.set('Content-Security-Policy', 'sandbox')
  out.set('X-Content-Type-Options', 'nosniff')
  out.set('Content-Disposition', 'attachment')
  out.set('Cross-Origin-Resource-Policy', 'cross-origin')
  out.set('X-Proxy-Final-Url', finalUrl)
  return out
}

export const createUniversalProxyRoutes = (
  auth: Auth,
  fetchFn: typeof fetch = globalThis.fetch,
  rateLimit?: AnyElysia,
  observability: ObservabilityRecorder = noopObservability,
) =>
  new Elysia({ prefix: '/proxy' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) g.use(rateLimit)

      g.onAfterResponse(({ request, set, user }) => {
        observability.proxyRequest({
          method: request.method.toUpperCase(),
          target_url: request.headers.get('x-proxy-target-url') ?? '',
          status: typeof set.status === 'number' ? set.status : 200,
          duration_ms: 0,
          user_id: (user as { id?: string } | undefined)?.id ?? 'unknown',
          request_id: crypto.randomUUID(),
          bytes_in: 0,
          bytes_out: 0,
        })
      })

      return g.all(
        '/',
        async (ctx) => {
          const method = ctx.request.method.toUpperCase()

          if (!allowedMethods.has(method)) {
            ctx.set.status = 405
            return new Response('Method not allowed', { headers: { 'Content-Type': 'text/plain' } })
          }

          // Read target URL from header (not path). Keeps user-supplied paths/queries
          // out of standard HTTP access logs which only record method + path.
          const targetHeader = ctx.request.headers.get('x-proxy-target-url')
          if (!targetHeader || targetHeader.trim() === '') {
            ctx.set.status = 400
            return new Response('Missing X-Proxy-Target-Url header', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }
          if (!isPrintableAscii(targetHeader)) {
            ctx.set.status = 400
            return new Response('Invalid X-Proxy-Target-Url header', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const normalised = normaliseTargetUrl(targetHeader)
          if ('error' in normalised) {
            ctx.set.status = 400
            return new Response(normalised.error, { headers: { 'Content-Type': 'text/plain' } })
          }

          // Strip userinfo before any further processing (matches validateAndPin).
          normalised.username = ''
          normalised.password = ''
          const targetUrl = normalised.toString()
          const initialOrigin = normalised.origin

          // Pre-check Content-Length to short-circuit oversized uploads before
          // opening any upstream connection. Streaming bodies without a header
          // are caught later by capStream.
          if (!bodylessMethods.has(method)) {
            const contentLength = ctx.request.headers.get('content-length')
            if (contentLength) {
              const cl = parseInt(contentLength, 10)
              if (Number.isFinite(cl) && cl > maxBodyBytes) {
                ctx.set.status = 413
                return new Response('Request body too large', {
                  headers: { 'Content-Type': 'text/plain' },
                })
              }
            }
          }

          // Parse X-Proxy-Follow-Redirects (strict literal match).
          const followRedirectsHeader = ctx.request.headers.get('x-proxy-follow-redirects')?.toLowerCase()
          const followOverride =
            followRedirectsHeader === 'true' ? true : followRedirectsHeader === 'false' ? false : null

          // Build outbound headers from X-Proxy-Passthrough-* prefix.
          const initialHeadersResult = buildOutboundHeaders(ctx.request.headers)
          if ('error' in initialHeadersResult) {
            ctx.set.status = 400
            return new Response(initialHeadersResult.error, {
              headers: { 'Content-Type': 'text/plain' },
            })
          }
          const initialPassthroughHeaders = initialHeadersResult

          // Decide whether redirect-following will need a buffered body.
          // - GET/HEAD have no body, so we can stream the initial hop and follow
          //   redirects safely (each hop is a fresh fetch).
          // - For other methods, default behaviour is "do not follow" (return 3xx as-is).
          //   If the caller explicitly opts in via X-Proxy-Follow-Redirects: true we
          //   buffer the body so it can be replayed on 307/308.
          const needsBodyBuffer = !bodylessMethods.has(method) && followOverride === true

          let bufferedBody: ArrayBuffer | null = null
          if (needsBodyBuffer && ctx.request.body) {
            bufferedBody = await new Response(ctx.request.body as BodyInit).arrayBuffer()
            if (bufferedBody.byteLength > maxBodyBytes) {
              ctx.set.status = 413
              return new Response('Request body too large', {
                headers: { 'Content-Type': 'text/plain' },
              })
            }
          }

          // Per-hop redirect loop: hop 0 = initial fetch; hops 1..maxHops = follows.
          let currentUrl = targetUrl
          let currentMethod = method
          let currentBufferedBody: ArrayBuffer | null = bufferedBody
          let dropAuthorizationOnHop = false

          for (let hop = 0; hop <= maxHops; hop++) {
            // DNS-pin each hop so cross-origin redirects can't bypass SSRF.
            let pinnedUrl: string
            let pinnedExtraHeaders: Headers
            try {
              ;[pinnedUrl, pinnedExtraHeaders] = await withDnsTimeout(validateAndPin(currentUrl))
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              if (hop === 0) {
                ctx.set.status = 400
                return new Response(`Blocked: ${msg}`, {
                  headers: { 'Content-Type': 'text/plain' },
                })
              }
              ctx.set.status = 502
              return new Response('Bad gateway (SSRF or DNS error on redirect)', {
                headers: { 'Content-Type': 'text/plain' },
              })
            }

            // Compose hop-specific headers: passthrough + Host (for SNI).
            const hopHeadersResult =
              hop === 0
                ? initialPassthroughHeaders
                : buildOutboundHeaders(ctx.request.headers, { dropAuthorization: dropAuthorizationOnHop })
            if ('error' in hopHeadersResult) {
              ctx.set.status = 400
              return new Response(hopHeadersResult.error, {
                headers: { 'Content-Type': 'text/plain' },
              })
            }
            const hopHeaders = new Headers(hopHeadersResult)
            pinnedExtraHeaders.forEach((value, key) => {
              hopHeaders.set(key, value)
            })

            const upstreamCtl = new AbortController()
            const isInitialHopStream = hop === 0 && !needsBodyBuffer && !bodylessMethods.has(currentMethod)

            // Wrap the inbound stream with capStream on the streaming initial hop so
            // body-size and idle-timeout limits still apply without buffering.
            const streamedInitialBody =
              isInitialHopStream && ctx.request.body
                ? capStream(ctx.request.body, {
                    maxBytes: streamCapBytes,
                    idleTimeoutMs: streamIdleMs,
                    onAbort: () => upstreamCtl.abort(),
                  })
                : null

            const upstreamBody: BodyInit | null = streamedInitialBody ?? currentBufferedBody ?? null

            const response = await fetchFn(pinnedUrl, {
              method: currentMethod,
              headers: hopHeaders,
              body: upstreamBody,
              redirect: 'manual',
              signal: upstreamCtl.signal,
              // @ts-expect-error -- Bun fetch supports duplex:'half' for streaming bodies
              duplex: 'half',
            })

            const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
            if (!isRedirect) {
              return buildProxyResponse(response, upstreamCtl, currentUrl)
            }

            // Decide whether to follow this redirect.
            const defaultFollow = currentMethod === 'GET' || currentMethod === 'HEAD'
            const shouldFollow = followOverride !== null ? followOverride : defaultFollow
            if (!shouldFollow) {
              return buildProxyResponse(response, upstreamCtl, currentUrl)
            }

            const location = response.headers.get('location')
            if (!location) {
              return buildProxyResponse(response, upstreamCtl, currentUrl)
            }

            // Resolve relative Location and auto-upgrade http://.
            const nextRaw = new URL(location, currentUrl).toString()
            const nextNormalised = normaliseTargetUrl(nextRaw)
            if ('error' in nextNormalised) {
              response.body?.cancel().catch(() => {})
              upstreamCtl.abort()
              ctx.set.status = 502
              return new Response('Redirect target is not http(s)', {
                headers: { 'Content-Type': 'text/plain' },
              })
            }
            nextNormalised.username = ''
            nextNormalised.password = ''
            const nextUrl = nextNormalised.toString()

            // Strip Authorization on the cross-origin hop to prevent credential leak.
            if (nextNormalised.origin !== initialOrigin) {
              dropAuthorizationOnHop = true
            }

            // RFC 7231: 303 always becomes GET; 301/302 become GET for non-GET/HEAD.
            let nextMethod = currentMethod
            let nextBody = currentBufferedBody
            if (response.status === 303) {
              nextMethod = 'GET'
              nextBody = null
            } else if ([301, 302].includes(response.status) && !['GET', 'HEAD'].includes(currentMethod)) {
              nextMethod = 'GET'
              nextBody = null
            }

            // Release the current hop before opening the next.
            response.body?.cancel().catch(() => {})
            upstreamCtl.abort()

            currentUrl = nextUrl
            currentMethod = nextMethod
            currentBufferedBody = nextBody
          }

          ctx.set.status = 502
          return new Response('Too many redirects', { headers: { 'Content-Type': 'text/plain' } })
        },
        { parse: 'none' },
      )
    })

const buildProxyResponse = (response: Response, upstreamCtl: AbortController, finalUrl: string): Response => {
  const headers = buildResponseHeaders(response.headers, finalUrl)

  const body = response.body
    ? capStream(response.body, {
        maxBytes: streamCapBytes,
        idleTimeoutMs: streamIdleMs,
        onAbort: () => upstreamCtl.abort(),
      })
    : null

  return new Response(body, {
    status: response.status,
    headers,
  })
}
