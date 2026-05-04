/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { defaultRequestDenylist, defaultResponseDenylist, extractResponseHeaders, filterHeaders } from '@/utils/request'
import { validateAndPin } from '@/utils/url-validation'
import { Elysia, type AnyElysia } from 'elysia'
import { capStream } from './streaming'
import { noopProxyObserver, type ProxyErrorType, type ProxyObserver } from './observability'

const maxBodyBytes = 10 * 1024 * 1024
const maxHops = 5
const dnsTimeoutMs = 5_000
const streamCapBytes = 10 * 1024 * 1024
const streamIdleMs = 30_000

const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const bodylessMethods = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Methods that are anonymous-by-design — browsers cannot attach credentials to subresource
 *  loads (`<img src>`, `<link rel="icon">`), so requiring auth would break the favicon /
 *  link-preview round-trip. SSRF defense and rate limiting still apply to these methods. */
const anonymousMethods = new Set(['GET', 'HEAD'])

/** Response denylist that intentionally keeps content-encoding so the browser can
 *  decode compressed bodies. We tell Bun NOT to decompress the upstream stream
 *  (`decompress: false` on the fetch call), so the Content-Encoding header
 *  matches the bytes we forward. */
const customRespDenylist = defaultResponseDenylist.filter((h) => h !== 'content-encoding')

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
const isPrintableAscii = (value: string) => /^[\x20-\x7E]+$/.test(value)

/** Generate or accept the request id — header takes precedence so callers can
 *  correlate proxy logs with their own request traces. Falls back to a UUID. */
const resolveRequestId = (headers: Headers): string => {
  const provided = headers.get('x-request-id')
  if (provided && isPrintableAscii(provided) && provided.length <= 200) {
    return provided
  }
  return crypto.randomUUID()
}

/** Map SSRF / DNS error messages from validateAndPin → withDnsTimeout to a
 *  classified label. Caller-provided `msg` is only used for the switch — it
 *  never reaches PostHog or spans. */
const classifyPinError = (msg: string): ProxyErrorType => {
  if (msg === 'DNS_TIMEOUT') return 'dns_timeout'
  return 'ssrf_block'
}

export const createUniversalProxyRoutes = (
  auth: Auth,
  fetchFn: typeof fetch = globalThis.fetch,
  rateLimit?: AnyElysia,
  observer: ProxyObserver = noopProxyObserver,
) => {
  const app = new Elysia({ prefix: '/proxy' })
    .onError(safeErrorHandler)
    /** Method-conditional auth: GET/HEAD MAY be anonymous because browsers cannot attach
     *  `Authorization: Bearer` to subresource loads (`<img src>`, `<link rel="icon">`).
     *  Every other method still requires a valid session. We always attempt session
     *  resolution so an authenticated GET/HEAD still surfaces `ctx.user` for observability
     *  and (eventually) per-user rate limiting. Inlined instead of the shared `auth: true`
     *  macro because the macro is unconditional by design. */
    .resolve(async ({ request, status }) => {
      const method = request.method.toUpperCase()
      const session = await auth.api.getSession({ headers: request.headers })
      if (session) {
        return { user: session.user, session: session.session }
      }
      if (anonymousMethods.has(method)) {
        return { user: undefined, session: undefined }
      }
      return status(401)
    })

  if (rateLimit) app.use(rateLimit)

  return app.all(
    '/*',
    async (ctx) => {
      const start = performance.now()
      const requestId = resolveRequestId(ctx.request.headers)
      const userId = ctx.user?.id ?? 'unknown'
      const method = ctx.request.method.toUpperCase()

      /** Snapshot used by every exit point — closure-captured. */
      let bytesIn = 0
      let targetHost = 'unknown'

      /** Emit one observation. Synchronous; safe to call from any path. */
      const emit = (status: number, errorType?: ProxyErrorType, errorMessage?: string, bytesOut = 0) => {
        observer({
          method,
          targetHost,
          status,
          durationMs: performance.now() - start,
          userId,
          requestId,
          bytesIn,
          bytesOut,
          ...(errorType ? { errorType } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        })
      }

      if (!allowedMethods.has(method)) {
        ctx.set.status = 405
        emit(405, 'method_not_allowed')
        return new Response('Method not allowed', { headers: { 'Content-Type': 'text/plain' } })
      }

      // Decode target URL from path segment after /proxy/
      const url = new URL(ctx.request.url)
      const proxyPrefixIndex = url.pathname.indexOf('/proxy/')
      const encodedTarget = url.pathname.slice(proxyPrefixIndex + '/proxy/'.length)

      let targetUrl: string
      try {
        targetUrl = decodeURIComponent(encodedTarget)
      } catch {
        ctx.set.status = 400
        emit(400, 'invalid_url', 'Invalid URL encoding')
        return new Response('Invalid URL encoding', { headers: { 'Content-Type': 'text/plain' } })
      }

      let parsedTarget: URL
      try {
        parsedTarget = new URL(targetUrl)
      } catch {
        ctx.set.status = 400
        emit(400, 'invalid_url', 'Invalid URL')
        return new Response('Invalid URL', { headers: { 'Content-Type': 'text/plain' } })
      }

      // Auto-upgrade http:// → https:// instead of rejecting. Many sites
      // (especially older Shopify storefronts) hardcode `http://` URLs in their
      // og:image / favicon meta tags even though the servers actually serve HTTPS.
      // Browsers transparently upgrade mixed-content subresources, but we extract
      // the literal URL from page metadata and would otherwise reject it. Upgrading
      // here keeps the common case working; sites that genuinely don't support
      // HTTPS surface as 502 upstream_error. Any other scheme (ftp:, data:, file:,
      // …) is still rejected by the protocol check below.
      if (parsedTarget.protocol === 'http:') {
        parsedTarget.protocol = 'https:'
        targetUrl = parsedTarget.toString()
      }

      targetHost = parsedTarget.hostname

      if (parsedTarget.protocol !== 'https:') {
        ctx.set.status = 400
        emit(400, 'unsupported_protocol', 'Only HTTPS targets are allowed')
        return new Response('Only HTTPS targets are allowed', { headers: { 'Content-Type': 'text/plain' } })
      }

      // CRLF guard on X-Upstream-Authorization (empty/missing values are treated as absent)
      const upstreamAuthRaw = ctx.request.headers.get('x-upstream-authorization')
      if (upstreamAuthRaw && !isPrintableAscii(upstreamAuthRaw)) {
        ctx.set.status = 400
        emit(400, 'invalid_header', 'Invalid X-Upstream-Authorization header')
        return new Response('Invalid X-Upstream-Authorization header', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      // Buffer request body once (so 307/308 can replay it)
      let requestBody: ArrayBuffer | null = null
      if (!bodylessMethods.has(method)) {
        const contentLength = ctx.request.headers.get('content-length')
        if (contentLength && parseInt(contentLength, 10) > maxBodyBytes) {
          ctx.set.status = 413
          emit(413, 'body_too_large')
          return new Response('Request body too large', { headers: { 'Content-Type': 'text/plain' } })
        }
        if (ctx.request.body) {
          requestBody = await new Response(ctx.request.body as BodyInit).arrayBuffer()
          if (requestBody.byteLength > maxBodyBytes) {
            ctx.set.status = 413
            bytesIn = requestBody.byteLength
            emit(413, 'body_too_large')
            return new Response('Request body too large', { headers: { 'Content-Type': 'text/plain' } })
          }
          bytesIn = requestBody.byteLength
        }
      }

      // Parse X-Proxy-Follow-Redirects (strict literal match)
      const followRedirectsHeader = ctx.request.headers.get('x-proxy-follow-redirects')?.toLowerCase()
      const followOverride = followRedirectsHeader === 'true' ? true : followRedirectsHeader === 'false' ? false : null

      // Build filtered outbound headers (strip hop-by-hop + auth + cookies)
      const filteredIncoming = filterHeaders(ctx.request.headers, [
        ...defaultRequestDenylist,
        'x-upstream-authorization',
        'x-proxy-follow-redirects',
      ])

      const initialOrigin = parsedTarget.origin

      // Per-hop redirect loop
      // hop 0 = initial fetch; hops 1..maxHops = redirect-follows (5 redirects max)
      let currentUrl = targetUrl
      let currentMethod = method
      let currentBody: ArrayBuffer | null = requestBody

      for (let hop = 0; hop <= maxHops; hop++) {
        // DNS-pin each hop
        let pinnedUrl: string
        let pinnedHeaders: Headers
        try {
          ;[pinnedUrl, pinnedHeaders] = await withDnsTimeout(validateAndPin(currentUrl, filteredIncoming))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (hop === 0) {
            ctx.set.status = 400
            emit(400, classifyPinError(msg))
            return new Response(`Blocked: ${msg}`, { headers: { 'Content-Type': 'text/plain' } })
          }
          ctx.set.status = 502
          emit(502, classifyPinError(msg))
          return new Response('Bad gateway (SSRF or DNS error on redirect)', {
            headers: { 'Content-Type': 'text/plain' },
          })
        }

        // Inject X-Upstream-Authorization → Authorization on same-origin hops
        const currentOrigin = new URL(currentUrl).origin
        if (upstreamAuthRaw && currentOrigin === initialOrigin) {
          pinnedHeaders.set('authorization', upstreamAuthRaw)
        }

        const upstreamCtl = new AbortController()

        let response: Response
        try {
          response = await fetchFn(pinnedUrl, {
            method: currentMethod,
            headers: pinnedHeaders,
            body: currentBody,
            redirect: 'manual',
            signal: upstreamCtl.signal,
            // @ts-expect-error -- Bun fetch supports duplex:'half' for streaming bodies
            duplex: 'half',
            // Bun fetch defaults to decompressing compressed responses; we forward
            // raw bytes so the upstream Content-Encoding (kept via customRespDenylist)
            // matches the body the browser receives. Without this, the browser sees
            // decompressed bytes labelled as gzip and fails with
            // ERR_CONTENT_DECODING_FAILED.
            decompress: false,
          })
        } catch {
          ctx.set.status = 502
          emit(502, 'upstream_error', 'Upstream fetch failed')
          return new Response('Bad gateway (upstream fetch failed)', {
            headers: { 'Content-Type': 'text/plain' },
          })
        }

        const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
        if (!isRedirect) {
          return buildProxyResponse(response, upstreamCtl, emit)
        }

        // Decide whether to follow
        const defaultFollow = currentMethod === 'GET' || currentMethod === 'HEAD'
        const shouldFollow = followOverride !== null ? followOverride : defaultFollow

        if (!shouldFollow) {
          return buildProxyResponse(response, upstreamCtl, emit)
        }

        // Resolve next hop URL
        const location = response.headers.get('location')
        if (!location) return buildProxyResponse(response, upstreamCtl, emit)

        const nextParsed = new URL(location, currentUrl)
        // Mirror the initial-hop auto-upgrade: http:// Location headers are
        // upgraded to https:// rather than aborted. Same rationale as the
        // initial-target upgrade above — sites with mixed-content redirects
        // shouldn't break, and HTTPS-only is still enforced (any non-http(s)
        // scheme falls through to the 502 below).
        if (nextParsed.protocol === 'http:') {
          nextParsed.protocol = 'https:'
        }
        const nextUrl = nextParsed.toString()

        if (nextParsed.protocol !== 'https:') {
          response.body?.cancel().catch(() => {})
          upstreamCtl.abort()
          ctx.set.status = 502
          emit(502, 'redirect_protocol', 'Redirect target is not HTTPS')
          return new Response('Redirect target is not HTTPS', { headers: { 'Content-Type': 'text/plain' } })
        }

        // Method conversion
        let nextMethod = currentMethod
        let nextBody: ArrayBuffer | null = currentBody
        if (response.status === 303) {
          nextMethod = 'GET'
          nextBody = null
        } else if ([301, 302].includes(response.status) && !['GET', 'HEAD'].includes(currentMethod)) {
          nextMethod = 'GET'
          nextBody = null
        }

        // Release the current hop's connection before following the redirect
        response.body?.cancel().catch(() => {})
        upstreamCtl.abort()

        currentUrl = nextUrl
        currentMethod = nextMethod
        currentBody = nextBody
      }

      // Unreachable in practice — hop loop returns before this, but the
      // type checker needs a final return.
      ctx.set.status = 502
      emit(502, 'too_many_redirects')
      return new Response('Too many redirects', { headers: { 'Content-Type': 'text/plain' } })
    },
    { parse: 'none' },
  )
}

const buildProxyResponse = (
  response: Response,
  upstreamCtl: AbortController,
  emit: (status: number, errorType?: ProxyErrorType, errorMessage?: string, bytesOut?: number) => void,
): Response => {
  const headers = extractResponseHeaders(response.headers, customRespDenylist)
  headers.delete('set-cookie')
  headers.delete('set-cookie2')
  headers.delete('trailer')

  // Force security headers (override any upstream value)
  headers.set('content-security-policy', 'sandbox')
  headers.set('content-disposition', 'attachment')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('cross-origin-resource-policy', 'cross-origin')

  if (!response.body) {
    emit(response.status)
    return new Response(null, { status: response.status, headers })
  }

  const body = capStream(response.body, {
    maxBytes: streamCapBytes,
    idleTimeoutMs: streamIdleMs,
    onAbort: () => upstreamCtl.abort(),
    onComplete: (bytesOut, reason) => {
      const errorType: ProxyErrorType | undefined =
        reason === 'cap'
          ? 'cap_exceeded'
          : reason === 'idle'
            ? 'idle_timeout'
            : reason === 'aborted'
              ? 'client_disconnect'
              : undefined
      emit(response.status, errorType, undefined, bytesOut)
    },
  })

  return new Response(body, {
    status: response.status,
    headers,
  })
}
