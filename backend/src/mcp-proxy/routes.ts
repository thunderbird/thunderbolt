import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSafeFetch, isLoopback, isPrivateAddress } from '@/utils/url-validation'
import { buildQueryString, extractResponseHeaders, filterHeaders } from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'
import type { Auth } from 'better-auth'

/** Max proxied response size (10MB — MCP tool results can include data payloads). */
const maxResponseBytes = 10 * 1024 * 1024

/** Proxy request timeout (30s — MCP operations can be slower than typical API calls). */
const proxyTimeoutMs = 30_000

/**
 * Validates MCP target URLs with SSRF protection.
 * Allows localhost (MCP servers run locally) but blocks all other private/internal addresses.
 */
const validateMcpTargetUrl = (url: string): { valid: boolean; error?: string } => {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP and HTTPS URLs are supported' }
    }
    const hostname = parsed.hostname
    if (!isLoopback(hostname) && isPrivateAddress(hostname)) {
      return { valid: false, error: 'Internal network addresses are not allowed' }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL' }
  }
}

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
  ctx: { headers: Record<string, string | undefined>; query: Record<string, string>; request: Request; set: { status?: number | string } },
  safeFetchFn: FetchFn,
) => {
  const validation = validateMcpTargetUrl(targetBaseUrl)
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

export const createMcpProxyRoutes = (fetchFn: typeof fetch = globalThis.fetch, auth?: Auth) => {
  const settings = getSettings()
  // Wrap fetch with DNS-level SSRF protection (resolves hostname, validates IPs before connecting)
  const safeFetchFn: FetchFn = createSafeFetch(fetchFn, { allowLoopback: true })

  const app = new Elysia({ prefix: '/mcp-proxy' })
    .onError(safeErrorHandler)
    .use(
      cors({
        origin: getCorsOrigins(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )

  // Require authentication when auth is available (skip OPTIONS for CORS preflight)
  if (auth) {
    app
      .derive(async ({ request }) => {
        if (request.method === 'OPTIONS') { return { user: null } }
        const session = await auth.api.getSession({ headers: request.headers })
        return { user: session?.user ?? null }
      })
      .onBeforeHandle(({ user, set, request }) => {
        if (request.method === 'OPTIONS') { return }
        if (!user) {
          set.status = 401
          return new Response('Authentication required', { status: 401, headers: { 'Content-Type': 'text/plain' } })
        }
      })
  }

  return app
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
