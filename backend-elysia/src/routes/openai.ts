import { getSettings } from '@/config/settings'
import { Elysia } from 'elysia'
import { defaultRequestDenylist, extractResponseHeaders, filterHeaders } from '../utils/request'

/**
 * OpenAI/Fireworks AI proxy routes
 */
export const createOpenAIRoutes = () => {
  const settings = getSettings()

  return new Elysia().all(
    '/openai/*',
    async (ctx) => {
      const path = ctx.params['*'] || ''
      const url = `https://api.fireworks.ai/inference/v1/${path}`

      if (!settings.fireworksApiKey) {
        ctx.set.status = 500
        throw new Error('Fireworks API key not configured')
      }

      const headers = {
        ...filterHeaders(ctx.headers, defaultRequestDenylist),
        Authorization: `Bearer ${settings.fireworksApiKey}`,
      }

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
