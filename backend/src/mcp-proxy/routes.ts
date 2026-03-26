import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { validateSafeUrl } from '@/pro/link-preview'
import { buildQueryString, extractResponseHeaders, filterHeaders } from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

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
      '/*',
      async (ctx) => {
        const targetBaseUrl = ctx.headers['x-mcp-target-url']
        if (!targetBaseUrl) {
          ctx.set.status = 400
          return new Response('Missing X-Mcp-Target-Url header', { headers: { 'Content-Type': 'text/plain' } })
        }

        const validation = validateSafeUrl(targetBaseUrl)
        if (!validation.valid) {
          ctx.set.status = 400
          return new Response(validation.error || 'Invalid target URL', { headers: { 'Content-Type': 'text/plain' } })
        }

        const subPath = ctx.params['*'] || ''
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
      },
      { parse: 'none' },
    )
}
