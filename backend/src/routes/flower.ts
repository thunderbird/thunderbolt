import { getCorsOrigins, getSettings } from '@/config/settings'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { defaultRequestDenylist, extractResponseHeaders, filterHeaders } from '../utils/request'

/**
 * Flower AI proxy routes
 */
export const createFlowerRoutes = () => {
  const settings = getSettings()
  
  return new Elysia({
    prefix: '/flower',
  }).use(
    cors({
      origin: getCorsOrigins(settings),
      allowedHeaders: [...settings.corsAllowHeaders.split(','), 'fi-sdk-type', 'fi-sdk-version'],
      exposeHeaders: settings.corsExposeHeaders,
    }),
  ).all(
    '/*',
    async (ctx) => {
      const path = ctx.params['*'] || ''
      const url = `https://api.flower.ai/${path}`

      const headers = filterHeaders(ctx.headers, defaultRequestDenylist)

      const response = await fetch(url + (ctx.query ? `?${new URLSearchParams(ctx.query)}` : ''), {
        method: ctx.request.method,
        headers,
        body: ctx.request.body as BodyInit,
      })

      return new Response(response.body, {
        status: response.status,
        headers: extractResponseHeaders(response.headers),
      })
    },
    {
      parse: 'none',
    },
  )
}
