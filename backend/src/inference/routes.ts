import { isPostHogConfigured } from '@/posthog/client'
import { createSSEStreamFromCompletion } from '@/utils/streaming'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { Elysia } from 'elysia'
import { APIConnectionError, APIConnectionTimeoutError } from 'openai'
import { getInferenceClient, type InferenceProvider } from './client'

type ModelConfig = {
  provider: InferenceProvider
  internalName: string
}

export const supportedModels: Record<string, ModelConfig> = {
  'gpt-oss-120b': {
    provider: 'thunderbolt',
    internalName: 'openai/gpt-oss-120b',
  },
  'mistral-large-3-fp8': {
    provider: 'fireworks',
    internalName: 'accounts/fireworks/models/mistral-large-3-fp8',
  },
  'qwen3-235b-a22b-instruct-2507': {
    provider: 'fireworks',
    internalName: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
  },
  'qwen3-235b-a22b-thinking-2507': {
    provider: 'fireworks',
    internalName: 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507',
  },
}

/**
 * Inference API routes
 */
export const createInferenceRoutes = () => {
  return new Elysia({
    prefix: '/chat',
  }).post('/completions', async (ctx) => {
    const body = await ctx.request.json()

    if (!body.stream) {
      throw new Error('Non-streaming requests are not supported')
    }

    const modelConfig = supportedModels[body.model]
    if (!modelConfig) {
      throw new Error('Model not found')
    }

    const { provider, internalName } = modelConfig
    const { client } = getInferenceClient(provider)

    console.log(`Routing model "${body.model}" to ${provider} provider`)

    try {
      const completion = await (client as PostHogOpenAI).chat.completions.create({
        model: internalName,
        messages: body.messages,
        temperature: body.temperature,
        tools: body.tools,
        tool_choice: body.tool_choice,
        stream: true,
        ...(isPostHogConfigured() && {
          posthogProperties: {
            model_provider: provider,
            endpoint: '/chat/completions',
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
      if (error instanceof APIConnectionError) {
        console.error('Failed to connect to inference provider', error.cause)
        throw new Error('Failed to connect to inference provider')
      }
      if (error instanceof APIConnectionTimeoutError) {
        console.error('Connection timeout to inference provider', error.cause)
        throw new Error('Connection timeout to inference provider')
      }
      throw error
    }
  })
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use createInferenceRoutes instead
 */
export const createOpenAIRoutes = createInferenceRoutes
