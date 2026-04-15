import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getCorsOriginsList, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { buildQueryString, extractResponseHeaders, filterHeaders } from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/** Max proxied request/response size (10MB — MCP tool results can include data payloads). */
const maxBodyBytes = 10 * 1024 * 1024

/** Proxy request timeout (30s — MCP operations can be slower than typical API calls). */
const proxyTimeoutMs = 30_000

/** Headers to strip from proxied MCP requests (mcp-authorization is rewritten to authorization below). */
const mcpRequestDenylist = [
  'host',
  'connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'cookie',
  'authorization',
  'mcp-authorization',
  'x-mcp-target-url',
  /^proxy-/i,
  /^x-forwarded-/i,
  'x-real-ip',
]

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Validates and forwards a proxied MCP request to the target server. */
const handleProxy = async (
  targetBaseUrl: string,
  subPath: string,
  ctx: {
    headers: Record<string, string | undefined>
    query: Record<string, string>
    request: Request
    set: { status?: number | string }
  },
  safeFetchFn: FetchFn,
) => {
  const validation = validateSafeUrl(targetBaseUrl)
  if (!validation.valid) {
    ctx.set.status = 400
    return new Response(validation.error || 'Invalid target URL', { headers: { 'Content-Type': 'text/plain' } })
  }

  const queryString = buildQueryString(ctx.query)
  const base = targetBaseUrl.replace(/\/+$/, '')
  const url = subPath ? `${base}/${subPath}${queryString}` : `${base}${queryString}`
  const headers = filterHeaders(ctx.headers, mcpRequestDenylist)

  const mcpAuth = ctx.headers['mcp-authorization']
  if (mcpAuth) {
    headers['authorization'] = mcpAuth
  }

  // Enforce request body size limit
  const requestContentLength = ctx.headers['content-length']
  if (requestContentLength && parseInt(requestContentLength, 10) > maxBodyBytes) {
    ctx.set.status = 413
    return new Response('Request body too large', { headers: { 'Content-Type': 'text/plain' } })
  }

  // Buffer request body and enforce size limit even without Content-Length
  let requestBody: ArrayBuffer | null = null
  if (ctx.request.body) {
    requestBody = await new Response(ctx.request.body as BodyInit).arrayBuffer()
    if (requestBody.byteLength > maxBodyBytes) {
      ctx.set.status = 413
      return new Response('Request body too large', { headers: { 'Content-Type': 'text/plain' } })
    }
  }

  // Timeout to prevent slow/malicious servers from holding connections indefinitely
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), proxyTimeoutMs)

  try {
    const response = await safeFetchFn(url, {
      method: ctx.request.method,
      headers,
      body: requestBody,
      signal: controller.signal,
    })

    // Reject responses exceeding size limit — check Content-Length first, then actual bytes
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > maxBodyBytes) {
      return new Response('Response too large', { status: 502, headers: { 'Content-Type': 'text/plain' } })
    }

    // Buffer response body to enforce size limit even for chunked/streamed responses
    const body = response.body ? await response.arrayBuffer() : null
    if (body && body.byteLength > maxBodyBytes) {
      return new Response('Response too large', { status: 502, headers: { 'Content-Type': 'text/plain' } })
    }

    const responseHeaders = extractResponseHeaders(response.headers)
    responseHeaders.delete('set-cookie')

    // Prevent XSS: proxied content must never execute scripts in our origin
    responseHeaders.set('content-security-policy', 'sandbox')
    responseHeaders.set('content-disposition', 'attachment')
    responseHeaders.set('x-content-type-options', 'nosniff')

    responseHeaders.set('cross-origin-resource-policy', 'cross-origin')

    return new Response(body, {
      status: response.status,
      headers: responseHeaders,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

export const createMcpProxyRoutes = (auth: Auth, fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()
  // Wrap fetch with DNS-level SSRF protection (resolves hostname, validates IPs before connecting)
  const safeFetchFn: FetchFn = createSafeFetch(fetchFn)

  return new Elysia({ prefix: '/mcp-proxy' })
    .onError(safeErrorHandler)
    .use(
      cors({
        origin: getCorsOriginsList(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .use(createAuthMacro(auth))
    .all(
      '/',
      async (ctx) => {
        const targetBaseUrl = ctx.headers['x-mcp-target-url']
        if (!targetBaseUrl) {
          ctx.set.status = 400
          return new Response('Missing X-Mcp-Target-Url header', { headers: { 'Content-Type': 'text/plain' } })
        }
        return handleProxy(targetBaseUrl, '', ctx, safeFetchFn)
      },
      { auth: true, parse: 'none' },
    )
    .all(
      '/*',
      async (ctx) => {
        const targetBaseUrl = ctx.headers['x-mcp-target-url']
        if (!targetBaseUrl) {
          ctx.set.status = 400
          return new Response('Missing X-Mcp-Target-Url header', { headers: { 'Content-Type': 'text/plain' } })
        }
        return handleProxy(targetBaseUrl, ctx.params['*'] || '', ctx, safeFetchFn)
      },
      { auth: true, parse: 'none' },
    )
}
