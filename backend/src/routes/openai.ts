import { getOpenAI } from '@/services/openai'
import { isPostHogConfigured } from '@/services/posthog'
import { createSSEStreamFromCompletion } from '@/utils/streaming'
import { type OpenAI as PostHogOpenAI } from '@posthog/ai'
import { Elysia } from 'elysia'

export const supportedModels = [
  'qwen3-235b-a22b-instruct-2507',
  'qwen3-235b-a22b-thinking-2507',
  'kimi-k2-instruct',
  'deepseek-r1-0528',
  'qwen3-235b-a22b',
  'llama-v3p1-405b-instruct',
]

/**
 * OpenAI/Fireworks AI proxy routes
 */
export const createOpenAIRoutes = () => {
  const openai = getOpenAI() as PostHogOpenAI

  return new Elysia().post('/openai/chat/completions', async (ctx) => {
    const body = await ctx.request.json()

    if (!body.stream) {
      throw new Error('Non-streaming requests are not supported')
    }

    if (!supportedModels.includes(body.model)) {
      throw new Error('Model not found')
    }

    try {
      const completion = await openai.chat.completions.create({
        model: `accounts/fireworks/models/${body.model}`,
        messages: body.messages,
        temperature: body.temperature,
        tools: body.tools,
        tool_choice: body.tool_choice,
        stream: true,
        ...(isPostHogConfigured() && {
          posthogProperties: {
            privacy_mode: true,
            model_provider: 'fireworks',
            endpoint: '/openai/chat/completions',
            has_tools: !!body.tools,
            temperature: body.temperature,
            // @todo add distinct id and trace id
          },
        }),
      })

      const stream = createSSEStreamFromCompletion(completion, body.model)

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    } catch (error) {
      console.error('OpenAI completion error:', error)
      ctx.set.status = 500
      throw new Error(`OpenAI completion failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  })
}
