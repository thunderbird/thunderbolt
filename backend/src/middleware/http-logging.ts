import { Elysia } from 'elysia'

/**
 * HTTP request/response logging middleware
 * Logs requests in Apache Common Log format with response time
 */
export const createHttpLoggingMiddleware = () => {
  return new Elysia({ name: 'http-logging' })
    .onRequest((ctx) => {
      const url = new URL(ctx.request.url)
      // Skip health/static endpoints
      if (url.pathname === '/v1/health' || url.pathname.startsWith('/static/')) {
        return
      }
      ;(ctx as any)._startTime = Date.now()
    })
    .onAfterHandle((ctx) => {
      const url = new URL(ctx.request.url)

      // Skip health/static and most PostHog endpoints (except config)
      if (url.pathname === '/v1/health' || url.pathname.startsWith('/static/')) {
        return
      }
      if (url.pathname.startsWith('/v1/posthog/') && url.pathname !== '/v1/posthog/config') {
        return
      }

      const startTime = (ctx as any)._startTime
      const responseTime = startTime ? Date.now() - startTime : undefined
      const status = ctx.set.status || 200

      // HTTP status code to text mapping
      const statusTextMap: Record<string, string> = {
        200: 'OK',
        201: 'Created',
        204: 'No Content',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        409: 'Conflict',
        422: 'Unprocessable Entity',
        429: 'Too Many Requests',
        500: 'Internal Server Error',
        503: 'Service Unavailable',
      }

      // Determine client address (best-effort behind proxies)
      const client = extractClientAddress(ctx.request.headers) || '-'
      const httpVersion = 'HTTP/1.1'
      const statusText = statusTextMap[String(status)] || ''
      const rt = responseTime !== undefined ? ` ${responseTime}ms` : ''

      // Apache Common Log format with response time
      const logLine = `${client} - "${ctx.request.method} ${url.pathname} ${httpVersion}" ${status}${statusText ? ` ${statusText}` : ''}${rt}`

      // Log using the decorated logger
      ;(ctx as any).log?.info(logLine)
    })
}

/**
 * Extract client IP address from request headers
 * Checks standard proxy headers in order of preference
 */
function extractClientAddress(headers: Headers): string | undefined {
  // Check RFC 7239 Forwarded header first
  const forwarded = headers.get('forwarded')
  if (forwarded) {
    const match = forwarded.match(/for=\"?([^;\"]+)/i)
    if (match && match[1]) {
      return match[1]
    }
  }

  // Check X-Forwarded-For
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    return xff.split(',')[0].trim()
  }

  // Check other common headers
  return headers.get('cf-connecting-ip') || headers.get('true-client-ip') || headers.get('x-real-ip') || undefined
}
