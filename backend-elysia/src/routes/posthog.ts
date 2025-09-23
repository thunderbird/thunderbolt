import { getSettings } from '@/config/settings'
import { Elysia } from 'elysia'
import { buildQueryString, defaultRequestDenylist, extractResponseHeaders, filterHeaders } from '../utils/request'

/**
 * PostHog analytics proxy routes
 */
export const createPostHogRoutes = () => {
  const settings = getSettings()

  return new Elysia().all(
    '/posthog/*',
    async (ctx) => {
      const path = ctx.params['*'] || ''
      const posthogHost = settings.posthogHost || 'https://us.i.posthog.com'

      const baseUrl = `${posthogHost}/${path}`
      const headers = filterHeaders(ctx.headers, defaultRequestDenylist)
      const queryString = buildQueryString(ctx.query)
      const url = `${baseUrl}${queryString}`

      const response = await fetch(url, {
        method: ctx.request.method,
        headers,
        body: ctx.request.body as BodyInit,
      })

      const responseHeaders = extractResponseHeaders(response.headers)

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
