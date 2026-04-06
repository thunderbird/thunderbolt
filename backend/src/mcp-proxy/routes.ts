import type { Auth } from '@/auth/elysia-plugin'
import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSessionGuard } from '@/middleware/session-guard'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { buildQueryString, extractResponseHeaders, filterHeaders } from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/** Max proxied response size (10MB — MCP tool results can include data payloads). */
const maxResponseBytes = 10 * 1024 * 1024

/** Proxy request timeout (30s — MCP operations can be slower than typical API calls). */
const proxyTimeoutMs = 30_000

/** Headers to strip from proxied MCP requests. Keeps Authorization and MCP headers. */
const mcpRequestDenylist = [
  'host',
  'connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'cookie',
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
  const url = subPath ? `${targetBaseUrl}/${subPath}${queryString}` : `${targetBaseUrl}${queryString}`
  const headers = filterHeaders(ctx.headers, mcpRequestDenylist)

  // Timeout to prevent slow/malicious servers from holding connections indefinitely
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), proxyTimeoutMs)

  try {
    const response = await safeFetchFn(url, {
      method: ctx.request.method,
      headers,
      body: ctx.request.body as BodyInit,
      redirect: 'manual',
      signal: controller.signal,
    })

    // Reject responses exceeding size limit (Content-Length check)
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      return new Response('Response too large', { status: 502, headers: { 'Content-Type': 'text/plain' } })
    }

    const responseHeaders = extractResponseHeaders(response.headers)
    responseHeaders.delete('set-cookie')
    responseHeaders.set('cross-origin-resource-policy', 'cross-origin')

    return new Response(response.body, {
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
        origin: getCorsOrigins(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .use(createSessionGuard(auth))
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
      { parse: 'none' },
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
      { parse: 'none' },
    )
}
