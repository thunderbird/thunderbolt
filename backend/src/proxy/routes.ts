/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { ensureHttps, validateAndPin, type DnsLookup } from '@/utils/url-validation'
import {
  droppedResponseHeaders,
  finalUrlHeader,
  followRedirectsHeader,
  passthroughPrefix,
  passthroughPrefixCased,
  redirectStatuses,
  targetUrlHeader,
} from '@shared/proxy-protocol'
import { Elysia, type AnyElysia } from 'elysia'
import { capStream } from './streaming'
import { noopObservability, type ObservabilityRecorder, type ProxyErrorType } from './observability'

/** Body cap is enforced post-content-encoding-passthrough: bytes counted are
 *  the compressed bytes coming off the wire. A user requesting a gzip-bombed
 *  resource sees the cap fire on the gzip stream, not the inflated bytes —
 *  this is acceptable per spec because the caller (browser, Tauri client)
 *  performs decompression and bears that risk for its own traffic. */
const maxBodyBytes = 10 * 1024 * 1024
const maxHops = 5
const dnsTimeoutMs = 5_000
const streamCapBytes = 10 * 1024 * 1024
const streamIdleMs = 30_000

const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const bodylessMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

const targetUrlHeaderLower = targetUrlHeader.toLowerCase()
const followRedirectsHeaderLower = followRedirectsHeader.toLowerCase()

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

const isPrintableAscii = (value: string) => /^[\x20-\x7E]*$/.test(value)

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })

/** Auto-upgrade `http://` URLs to `https://` and reject all other non-https schemes. */
const normaliseTargetUrl = (raw: string): URL | { error: string } => {
  const upgraded = ensureHttps(raw)
  if (!upgraded) {
    try {
      new URL(raw)
      return { error: 'Only http:// or https:// targets are allowed' }
    } catch {
      return { error: 'Invalid URL' }
    }
  }
  return new URL(upgraded)
}

/** Strip the passthrough prefix off inbound headers and validate values. Returns
 *  the assembled outbound headers, or a string error message. Callers that pass
 *  `dropAuthorization: true` strip Authorization (cross-origin redirects). */
const buildOutboundHeaders = (
  inbound: Headers,
  { dropAuthorization }: { dropAuthorization: boolean } = { dropAuthorization: false },
): Headers | { error: string } => {
  const out = new Headers()
  let invalid = false
  inbound.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!lower.startsWith(passthroughPrefix)) {
      return
    }
    const upstreamKey = lower.slice(passthroughPrefix.length)
    if (!upstreamKey) {
      return
    }
    if (!isPrintableAscii(value)) {
      invalid = true
      return
    }
    if (dropAuthorization && upstreamKey === 'authorization') {
      return
    }
    out.set(upstreamKey, value)
  })
  if (invalid) {
    return { error: 'Invalid passthrough header value' }
  }
  return out
}

/** Re-prefix every upstream response header so the browser ignores them and the
 *  caller's `proxyFetch` helper unwraps them back into a normal-looking Response.
 *  `content-encoding` IS forwarded — Bun is called with `decompress: false` so
 *  the original compressed bytes flow through and the browser decodes. */
const buildResponseHeaders = (upstream: Headers, finalUrl: string): Headers => {
  const out = new Headers()
  upstream.forEach((value, key) => {
    if (droppedResponseHeaders.has(key.toLowerCase())) {
      return
    }
    out.set(`${passthroughPrefixCased}${key}`, value)
  })

  // Proxy-set headers (NOT prefixed): describe the proxy's own response framing
  // and security posture. Forced — override anything the upstream might have sent.
  out.set('Content-Security-Policy', 'sandbox')
  out.set('X-Content-Type-Options', 'nosniff')
  out.set('Content-Disposition', 'attachment')
  out.set('Cross-Origin-Resource-Policy', 'cross-origin')
  out.set(finalUrlHeader, finalUrl)
  return out
}

/** Classify an upstream HTTP status into an observability error category, or
 *  return undefined if the response is not an error from the proxy's POV.
 *  Upstream redirect statuses are intentionally NOT errors. */
const classifyUpstreamStatus = (status: number): ProxyErrorType | undefined => {
  if (status >= 500) {
    return 'upstream_5xx'
  }
  if (status >= 400) {
    return 'upstream_4xx'
  }
  return undefined
}

export type CreateUniversalProxyRoutesOptions = {
  auth: Auth
  fetchFn?: typeof fetch
  rateLimit?: AnyElysia
  observability?: ObservabilityRecorder
  dnsLookup?: DnsLookup
}

export const createUniversalProxyRoutes = (options: CreateUniversalProxyRoutesOptions) => {
  const { auth, rateLimit, dnsLookup } = options
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const observability = options.observability ?? noopObservability

  return new Elysia({ prefix: '/proxy' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) {
        g.use(rateLimit)
      }

      return g
        .derive(({ request }) => ({
          proxyStartedAt: performance.now(),
          proxyRequestId: crypto.randomUUID(),
          proxyTargetUrl: request.headers.get(targetUrlHeaderLower) ?? '',
        }))
        .all(
          '/',
          async (ctx) => {
            const method = ctx.request.method.toUpperCase()
            const userId = (ctx.user as { id?: string } | undefined)?.id ?? 'unknown'

            /** Emit a final observability event. `bytesIn`/`bytesOut` default to 0
             *  for paths that never opened an upstream connection. */
            const emit = (params: {
              response: Response
              targetUrl: string
              bytesIn: number
              bytesOut: number
              errorType?: ProxyErrorType
            }) => {
              observability.proxyRequest({
                method,
                target_url: params.targetUrl,
                status: params.response.status,
                duration_ms: Math.round(performance.now() - ctx.proxyStartedAt),
                bytes_in: params.bytesIn,
                bytes_out: params.bytesOut,
                user_id: userId,
                request_id: ctx.proxyRequestId,
                error_type: params.errorType,
              })
            }

            /** Build + emit a failure Response in one shot. Status is derived
             *  from the textResponse, so observability never disagrees with
             *  what the caller actually sees. */
            const fail = (status: number, body: string, errorType: ProxyErrorType, targetUrl = ''): Response => {
              const response = textResponse(status, body)
              emit({ response, targetUrl, bytesIn: 0, bytesOut: 0, errorType })
              return response
            }

            if (!allowedMethods.has(method)) {
              return fail(405, 'Method not allowed', 'invalid_target')
            }

            // Read target URL from header (not path). Keeps user-supplied paths/queries
            // out of standard HTTP access logs which only record method + path.
            const targetHeader = ctx.proxyTargetUrl
            if (!targetHeader || targetHeader.trim() === '') {
              return fail(400, `Missing ${targetUrlHeader} header`, 'invalid_target')
            }
            if (!isPrintableAscii(targetHeader)) {
              return fail(400, `Invalid ${targetUrlHeader} header`, 'invalid_target')
            }

            const normalised = normaliseTargetUrl(targetHeader)
            if ('error' in normalised) {
              return fail(400, normalised.error, 'invalid_target')
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
                  return fail(413, 'Request body too large', 'cap_exceeded', targetUrl)
                }
              }
            }

            // Strict literal match — anything other than 'true'/'false' falls back to default.
            const followRedirectsValue = ctx.request.headers.get(followRedirectsHeaderLower)?.toLowerCase()
            const followOverride =
              followRedirectsValue === 'true' ? true : followRedirectsValue === 'false' ? false : null

            const initialHeadersResult = buildOutboundHeaders(ctx.request.headers)
            if ('error' in initialHeadersResult) {
              return fail(400, initialHeadersResult.error, 'invalid_target', targetUrl)
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
              // Stream the body into a bounded accumulator. Reading via Response#arrayBuffer
              // would materialise the FULL upload into memory before any size check, letting
              // a chunked upload (no Content-Length) OOM the server. Here we early-terminate
              // the moment we exceed maxBodyBytes so worst-case memory is ~one chunk over.
              const reader = (ctx.request.body as ReadableStream<Uint8Array>).getReader()
              const chunks: Uint8Array[] = []
              let total = 0
              try {
                for (;;) {
                  const { done, value } = await reader.read()
                  if (done) {
                    break
                  }
                  total += value.byteLength
                  if (total > maxBodyBytes) {
                    reader.cancel().catch(() => {})
                    return fail(413, 'Request body too large', 'cap_exceeded', targetUrl)
                  }
                  chunks.push(value)
                }
              } finally {
                reader.releaseLock()
              }
              const merged = new Uint8Array(total)
              let offset = 0
              for (const chunk of chunks) {
                merged.set(chunk, offset)
                offset += chunk.byteLength
              }
              bufferedBody = merged.buffer
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
                ;[pinnedUrl, pinnedExtraHeaders] = await withDnsTimeout(
                  validateAndPin(currentUrl, undefined, dnsLookup),
                )
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                const isTimeout = msg === 'DNS_TIMEOUT'
                if (hop === 0) {
                  return fail(400, `Blocked: ${msg}`, isTimeout ? 'dns_timeout' : 'ssrf', currentUrl)
                }
                return fail(
                  502,
                  'Bad gateway (SSRF or DNS error on redirect)',
                  isTimeout ? 'dns_timeout' : 'ssrf',
                  currentUrl,
                )
              }

              // Compose hop-specific headers: passthrough + Host (for SNI).
              const hopHeadersResult =
                hop === 0
                  ? initialPassthroughHeaders
                  : buildOutboundHeaders(ctx.request.headers, { dropAuthorization: dropAuthorizationOnHop })
              if ('error' in hopHeadersResult) {
                return fail(400, hopHeadersResult.error, 'invalid_target', currentUrl)
              }
              const hopHeaders = new Headers(hopHeadersResult)
              pinnedExtraHeaders.forEach((value, key) => {
                hopHeaders.set(key, value)
              })

              const upstreamCtl = new AbortController()
              const isInitialHopStream = hop === 0 && !needsBodyBuffer && !bodylessMethods.has(currentMethod)

              // Wrap the inbound stream with capStream on the streaming initial hop so
              // body-size and idle-timeout limits still apply without buffering. The
              // returned `bytesRead()` gives observability the real upload size.
              const requestCap =
                isInitialHopStream && ctx.request.body
                  ? capStream(ctx.request.body, {
                      maxBytes: streamCapBytes,
                      idleTimeoutMs: streamIdleMs,
                      onAbort: () => upstreamCtl.abort(),
                    })
                  : null

              const upstreamBody: BodyInit | null = requestCap?.stream ?? currentBufferedBody ?? null

              // Bun-specific fetch options: `decompress: false` lets the original
              // compressed bytes (and `content-encoding`) pass through unchanged so
              // the browser decodes; `duplex: 'half'` enables streaming request
              // bodies. Both are absent from the standard `RequestInit` type.
              // Bun (>=1.3) auto-decompresses but ALSO keeps `content-encoding` on the
              // Response — without `decompress: false` we would forward gzip headers
              // with already-decoded bodies and the browser would corrupt the result.
              // Verified empirically on Bun 1.3.10; if Bun ever changes this, the
              // routes.test.ts "passes decompress: false" assertion will still pass
              // but real responses will silently break — add an integration test
              // before bumping Bun major.
              const response = await fetchFn(pinnedUrl, {
                method: currentMethod,
                headers: hopHeaders,
                body: upstreamBody,
                redirect: 'manual',
                signal: upstreamCtl.signal,
                decompress: false,
                duplex: 'half',
              } as RequestInit & { decompress: boolean; duplex: 'half' })

              /** Bytes uploaded to upstream. Buffered bodies have a fixed size known
               *  up-front; for streamed bodies we expose a late-read getter so the
               *  observability emission (which fires from the *response* stream's
               *  onComplete) sees the final value after the upload has actually
               *  drained, not the in-flight count at the moment response headers
               *  were received. */
              const bytesIn: () => number =
                requestCap !== null ? requestCap.bytesRead : () => currentBufferedBody?.byteLength ?? 0

              if (!redirectStatuses.has(response.status)) {
                return buildProxyResponse(response, upstreamCtl, currentUrl, {
                  emit,
                  targetUrl: currentUrl,
                  bytesIn,
                })
              }

              const defaultFollow = bodylessMethods.has(currentMethod)
              const shouldFollow = followOverride !== null ? followOverride : defaultFollow
              if (!shouldFollow) {
                return buildProxyResponse(response, upstreamCtl, currentUrl, {
                  emit,
                  targetUrl: currentUrl,
                  bytesIn,
                })
              }

              const location = response.headers.get('location')
              if (!location) {
                return buildProxyResponse(response, upstreamCtl, currentUrl, {
                  emit,
                  targetUrl: currentUrl,
                  bytesIn,
                })
              }

              // Resolve relative Location and auto-upgrade http://.
              const nextRaw = new URL(location, currentUrl).toString()
              const nextNormalised = normaliseTargetUrl(nextRaw)
              if ('error' in nextNormalised) {
                upstreamCtl.abort()
                return fail(502, 'Redirect target is not http(s)', 'invalid_target', currentUrl)
              }
              nextNormalised.username = ''
              nextNormalised.password = ''
              const nextUrl = nextNormalised.toString()

              if (nextNormalised.origin !== initialOrigin) {
                dropAuthorizationOnHop = true
              }

              // RFC 7231: 303 always becomes GET; 301/302 become GET for non-GET/HEAD.
              let nextMethod = currentMethod
              let nextBody = currentBufferedBody
              if (response.status === 303) {
                nextMethod = 'GET'
                nextBody = null
              } else if ((response.status === 301 || response.status === 302) && !bodylessMethods.has(currentMethod)) {
                nextMethod = 'GET'
                nextBody = null
              }

              // Release the current hop before opening the next.
              upstreamCtl.abort()

              currentUrl = nextUrl
              currentMethod = nextMethod
              currentBufferedBody = nextBody
            }

            return fail(502, 'Too many redirects', 'upstream_5xx', currentUrl)
          },
          { parse: 'none' },
        )
    })
}

/** Wrap the upstream response: cap+idle on the response body, force security
 *  headers, and emit the observability event when the response stream finishes
 *  (or aborts). The capStream `onComplete` is the single emission point so cap
 *  bytes and event timing are always consistent. */
const buildProxyResponse = (
  response: Response,
  upstreamCtl: AbortController,
  finalUrl: string,
  observe: {
    emit: (params: {
      response: Response
      targetUrl: string
      bytesIn: number
      bytesOut: number
      errorType?: ProxyErrorType
    }) => void
    targetUrl: string
    /** Late-read getter — invoked at emission time so streamed uploads have
     *  drained before bytes_in is recorded. */
    bytesIn: () => number
  },
): Response => {
  const headers = buildResponseHeaders(response.headers, finalUrl)
  const out = new Response(null, { status: response.status, headers })
  const upstreamErrorType = classifyUpstreamStatus(response.status)

  if (!response.body) {
    observe.emit({
      response: out,
      targetUrl: observe.targetUrl,
      bytesIn: observe.bytesIn(),
      bytesOut: 0,
      errorType: upstreamErrorType,
    })
    return out
  }

  // capStream's onAbort fires before onComplete; latch the abort reason so the
  // single onComplete emission can promote `error_type` accordingly.
  let abortReason: 'cap' | 'idle' | null = null
  const cap = capStream(response.body, {
    maxBytes: streamCapBytes,
    idleTimeoutMs: streamIdleMs,
    onAbort: (reason) => {
      abortReason = reason
      upstreamCtl.abort()
    },
    onComplete: (bytesOut) => {
      const errorType: ProxyErrorType | undefined =
        abortReason === 'cap' ? 'cap_exceeded' : abortReason === 'idle' ? 'idle_timeout' : upstreamErrorType
      observe.emit({
        response: out,
        targetUrl: observe.targetUrl,
        bytesIn: observe.bytesIn(),
        bytesOut,
        errorType,
      })
    },
  })

  return new Response(cap.stream, { status: response.status, headers })
}
