import { getSettings } from '@/config/settings'
import { createFireworks } from '@ai-sdk/fireworks'
import { streamText } from 'ai'
import { Elysia, sse } from 'elysia'
import { defaultRequestDenylist, extractResponseHeaders, filterHeaders } from '../utils/request'

/**
 * OpenAI/Fireworks AI proxy routes
 */
export const createOpenAIRoutes = () => {
  const settings = getSettings()

  const fireworks = createFireworks({
    apiKey: settings.fireworksApiKey,
  })

  return new Elysia()
    .post('/openai/chat/completions', async function* (ctx) {
      const body = await ctx.request.json()

      if (!body.stream) {
        throw new Error('Non-streaming requests are not supported')
      }

      const { textStream } = await streamText({
        model: fireworks(`accounts/fireworks/models/${body.model}`),
        messages: body.messages,
        temperature: body.temperature,
        tools: body.tools,
        toolChoice: body.tool_choice,
      })

      console.log('textStream', textStream)
      for await (const textPart of textStream) {
        yield sse(textPart)
      }
    })
    .all(
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
