import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { buildQueryString, defaultRequestDenylist, extractResponseHeaders, filterHeaders } from '@/utils/request'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * PostHog analytics proxy routes
 */
export const createPostHogRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()

  return (
    new Elysia({
      prefix: '/posthog',
    })
      .onError(safeErrorHandler)
      .use(
        cors({
          origin: getCorsOrigins(settings),
          allowedHeaders: settings.corsAllowHeaders,
          exposeHeaders: settings.corsExposeHeaders,
        }),
      )
      .get('/config', async () => {
        return {
          posthog_api_key: settings.posthogApiKey,
        }
      })
      // Unauthenticated by design: PostHog analytics are anonymous client-side events.
      // The proxy target is fixed to posthogHost — it cannot be redirected to arbitrary hosts.
      // PostHog's API rejects events without a valid project API key.
      // Rate limiting is the appropriate mitigation for abuse, not authentication.
      .all(
        '/*',
        async (ctx) => {
          const path = ctx.params['*'] || ''
          const posthogHost = settings.posthogHost || 'https://us.i.posthog.com'

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
  )
}
