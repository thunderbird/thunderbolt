import { getCorsOriginsList, getSettings, type Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import {
  buildQueryString,
  defaultRequestDenylist,
  extractClientIp,
  extractResponseHeaders,
  filterHeaders,
} from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

const maxBodyBytes = 3 * 1024 * 1024

/**
 * PostHog analytics proxy routes — intentionally public (no auth).
 * Events are anonymous client-side analytics; the proxy target is fixed to posthogHost.
 * PostHog's API rejects events without a valid project API key.
 */
export const createPostHogRoutes = (fetchFn: typeof fetch = globalThis.fetch, settings?: Settings) => {
  const _settings = settings ?? getSettings()

  const rateLimiter = new RateLimiterMemory({
    points: 60,
    duration: 60,
    keyPrefix: 'posthog',
  })

  return new Elysia({
    prefix: '/posthog',
  })
    .onError(safeErrorHandler)
    .use(
      cors({
        origin: getCorsOriginsList(_settings),
        allowedHeaders: _settings.corsAllowHeaders,
        exposeHeaders: _settings.corsExposeHeaders,
      }),
    )
    .onBeforeHandle(async (ctx) => {
      const socketIp = ctx.server?.requestIP(ctx.request)?.address ?? 'unknown'
      const clientIp = extractClientIp(ctx.request.headers, socketIp, _settings.trustedProxy)

      try {
        const res = await rateLimiter.consume(clientIp)
        ctx.set.headers['RateLimit-Limit'] = String(rateLimiter.points)
        ctx.set.headers['RateLimit-Remaining'] = String(res.remainingPoints)
        ctx.set.headers['RateLimit-Reset'] = String(Math.ceil(res.msBeforeNext / 1000))
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          ctx.set.status = 429
          ctx.set.headers['Retry-After'] = String(Math.ceil(err.msBeforeNext / 1000))
          ctx.set.headers['RateLimit-Limit'] = String(rateLimiter.points)
          ctx.set.headers['RateLimit-Remaining'] = '0'
          ctx.set.headers['RateLimit-Reset'] = String(Math.ceil(err.msBeforeNext / 1000))
          return { error: 'Too many requests. Please try again later.' }
        }
        throw err
      }
    })
    .get('/config', async () => {
      return {
        public_posthog_api_key: _settings.posthogApiKey,
      }
    })
    .all(
      '/*',
      async (ctx) => {
        const contentLength = ctx.request.headers.get('content-length')
        if (contentLength) {
          const parsed = parseInt(contentLength, 10)
          if (!Number.isNaN(parsed) && parsed > maxBodyBytes) {
            ctx.set.status = 413
            return { error: 'Request body too large' }
          }
        }

        const path = ctx.params['*'] || ''
        const posthogHost = _settings.posthogHost || 'https://us.i.posthog.com'

        const baseUrl = `${posthogHost}/${path}`
        const headers = filterHeaders(ctx.headers, defaultRequestDenylist)
        const queryString = buildQueryString(ctx.query)
        const url = `${baseUrl}${queryString}`

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
      {
        parse: 'none',
      },
    )
}
