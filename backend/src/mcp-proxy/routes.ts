import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { isLoopback, isPrivateAddress } from '@/utils/url-validation'
import { buildQueryString, extractResponseHeaders, filterHeaders } from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

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
    // Allow localhost for local MCP servers, block all other private addresses
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

/** Validates and forwards a proxied MCP request to the target server. */
const handleProxy = async (
  targetBaseUrl: string,
  subPath: string,
  ctx: { headers: Record<string, string | undefined>; query: Record<string, string>; request: Request; set: { status?: number | string } },
  fetchFn: typeof fetch,
) => {
  const validation = validateMcpTargetUrl(targetBaseUrl)
  if (!validation.valid) {
    ctx.set.status = 400
    return new Response(validation.error || 'Invalid target URL', { headers: { 'Content-Type': 'text/plain' } })
  }

  const queryString = buildQueryString(ctx.query)
  const url = subPath ? `${targetBaseUrl}/${subPath}${queryString}` : `${targetBaseUrl}${queryString}`
  const headers = filterHeaders(ctx.headers, mcpRequestDenylist)

  const response = await fetchFn(url, {
    method: ctx.request.method,
    headers,
    body: ctx.request.body as BodyInit,
  })

  const responseHeaders = extractResponseHeaders(response.headers)
  responseHeaders.set('cross-origin-resource-policy', 'cross-origin')

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  })
}

export const createMcpProxyRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()

  return new Elysia({ prefix: '/mcp-proxy' })
    .onError(safeErrorHandler)
    .use(
      cors({
        origin: getCorsOrigins(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .all(
      '/',
      async (ctx) => {
        const targetBaseUrl = ctx.headers['x-mcp-target-url']
        if (!targetBaseUrl) {
          ctx.set.status = 400
          return new Response('Missing X-Mcp-Target-Url header', { headers: { 'Content-Type': 'text/plain' } })
        }
        return handleProxy(targetBaseUrl, '', ctx, fetchFn)
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
        return handleProxy(targetBaseUrl, ctx.params['*'] || '', ctx, fetchFn)
      },
      { parse: 'none' },
    )
}
