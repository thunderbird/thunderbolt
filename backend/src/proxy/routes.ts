import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { defaultRequestDenylist, defaultResponseDenylist, extractResponseHeaders, filterHeaders } from '@/utils/request'
import { validateAndPin } from '@/utils/url-validation'
import { Elysia, type AnyElysia } from 'elysia'
import { capStream } from './streaming'

const maxBodyBytes = 10 * 1024 * 1024
const maxHops = 5
const dnsTimeoutMs = 5_000
const streamCapBytes = 10 * 1024 * 1024
const streamIdleMs = 30_000

const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const bodylessMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Response denylist that intentionally keeps content-encoding (fix for SF7). */
const customRespDenylist = defaultResponseDenylist.filter((h) => h !== 'content-encoding')

/** Race a promise against a DNS timeout. Throws `Error('DNS_TIMEOUT')` on expiry. */
const withDnsTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS_TIMEOUT')), dnsTimeoutMs)),
  ])

/** Printable ASCII guard — rejects CRLF and control characters. */
const isPrintableAscii = (value: string) => /^[\x20-\x7E]+$/.test(value)

export const createUniversalProxyRoutes = (
  auth: Auth,
  fetchFn: typeof fetch = globalThis.fetch,
  rateLimit?: AnyElysia,
) =>
  new Elysia({ prefix: '/proxy' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) g.use(rateLimit)

      return g.all(
        '/*',
        async (ctx) => {
          const method = ctx.request.method.toUpperCase()

          if (!allowedMethods.has(method)) {
            ctx.set.status = 405
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
            return new Response('Invalid URL encoding', { headers: { 'Content-Type': 'text/plain' } })
          }

          let parsedTarget: URL
          try {
            parsedTarget = new URL(targetUrl)
          } catch {
            ctx.set.status = 400
            return new Response('Invalid URL', { headers: { 'Content-Type': 'text/plain' } })
          }

          if (parsedTarget.protocol !== 'https:') {
            ctx.set.status = 400
            return new Response('Only HTTPS targets are allowed', { headers: { 'Content-Type': 'text/plain' } })
          }

          // CRLF guard on X-Upstream-Authorization (empty/missing values are treated as absent)
          const upstreamAuthRaw = ctx.request.headers.get('x-upstream-authorization')
          if (upstreamAuthRaw && !isPrintableAscii(upstreamAuthRaw)) {
            ctx.set.status = 400
            return new Response('Invalid X-Upstream-Authorization header', { headers: { 'Content-Type': 'text/plain' } })
          }

          // Buffer request body once (so 307/308 can replay it)
          let requestBody: ArrayBuffer | null = null
          if (!bodylessMethods.has(method)) {
            const contentLength = ctx.request.headers.get('content-length')
            if (contentLength && parseInt(contentLength, 10) > maxBodyBytes) {
              ctx.set.status = 413
              return new Response('Request body too large', { headers: { 'Content-Type': 'text/plain' } })
            }
            if (ctx.request.body) {
              requestBody = await new Response(ctx.request.body as BodyInit).arrayBuffer()
              if (requestBody.byteLength > maxBodyBytes) {
                ctx.set.status = 413
                return new Response('Request body too large', { headers: { 'Content-Type': 'text/plain' } })
              }
            }
          }

          // Parse X-Proxy-Follow-Redirects (strict literal match)
          const followRedirectsHeader = ctx.request.headers.get('x-proxy-follow-redirects')?.toLowerCase()
          const followOverride =
            followRedirectsHeader === 'true' ? true : followRedirectsHeader === 'false' ? false : null

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
                return new Response(`Blocked: ${msg}`, { headers: { 'Content-Type': 'text/plain' } })
              }
              ctx.set.status = 502
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

            const response = await fetchFn(pinnedUrl, {
              method: currentMethod,
              headers: pinnedHeaders,
              body: currentBody,
              redirect: 'manual',
              signal: upstreamCtl.signal,
              // @ts-expect-error -- Bun fetch supports duplex:'half' for streaming bodies
              duplex: 'half',
            })

            const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
            if (!isRedirect) {
              return buildProxyResponse(response, upstreamCtl)
            }

            // Decide whether to follow
            const defaultFollow = currentMethod === 'GET' || currentMethod === 'HEAD'
            const shouldFollow = followOverride !== null ? followOverride : defaultFollow

            if (!shouldFollow) {
              return buildProxyResponse(response, upstreamCtl)
            }

            // Resolve next hop URL
            const location = response.headers.get('location')
            if (!location) return buildProxyResponse(response, upstreamCtl)

            const nextUrl = new URL(location, currentUrl).toString()

            if (new URL(nextUrl).protocol !== 'https:') {
              response.body?.cancel().catch(() => {})
              upstreamCtl.abort()
              ctx.set.status = 502
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

          // Unreachable — satisfies TypeScript
          ctx.set.status = 502
          return new Response('Too many redirects', { headers: { 'Content-Type': 'text/plain' } })
        },
        { parse: 'none' },
      )
    })

const buildProxyResponse = (response: Response, upstreamCtl: AbortController): Response => {
  const headers = extractResponseHeaders(response.headers, customRespDenylist)
  headers.delete('set-cookie')
  headers.delete('set-cookie2')
  headers.delete('trailer')

  // Force security headers (override any upstream value)
  headers.set('content-security-policy', 'sandbox')
  headers.set('content-disposition', 'attachment')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('cross-origin-resource-policy', 'cross-origin')

  const body =
    response.body
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
