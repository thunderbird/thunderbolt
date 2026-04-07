import type { Auth } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSessionGuard } from '@/middleware/session-guard'
import { isPostHogConfigured } from '@/posthog/client'
import { createSSEStreamFromCompletion } from '@/utils/streaming'
import type { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { Elysia, type AnyElysia } from 'elysia'
import { APIConnectionError, APIConnectionTimeoutError } from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getInferenceClient, type InferenceProvider } from './client'

type Message = { role: string; content: unknown }

const privilegedRoles = new Set(['developer', 'system'])

/** Downgrade developer/system roles to user for all messages except the first (the legitimate system prompt). */
const sanitizeMessageRoles = (messages: Message[]): Message[] =>
  messages.map((msg, i) => (i > 0 && privilegedRoles.has(msg.role) ? { ...msg, role: 'user' } : msg))

type ModelConfig = {
  provider: InferenceProvider
  internalName: string
}

export const supportedModels: Record<string, ModelConfig> = {
  'gpt-oss-120b': {
    provider: 'thunderbolt',
    internalName: 'openai/gpt-oss-120b',
  },
  'mistral-medium-3.1': {
    provider: 'mistral',
    internalName: 'mistral-medium-2508',
  },
  'mistral-large-3': {
    provider: 'mistral',
    internalName: 'mistral-large-2512',
  },
  'sonnet-4.5': {
    provider: 'anthropic',
    internalName: 'claude-sonnet-4-5',
  },
}

/**
 * Inference API routes
 */
export const createInferenceRoutes = (auth: Auth, rateLimit?: AnyElysia) => {
  const app = new Elysia({
    prefix: '/chat',
  })
    .onError(safeErrorHandler)
    .use(createSessionGuard(auth))

  if (rateLimit) app.use(rateLimit)

  return app.post('/completions', async (ctx) => {
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

    console.info(`Routing model "${body.model}" to ${provider} provider`)

    try {
      const completion = await (client as PostHogOpenAI).chat.completions.create({
        model: internalName,
        messages: sanitizeMessageRoles(body.messages) as ChatCompletionMessageParam[],
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

      // Merge rate-limit headers (set by middleware on ctx.set.headers) into the
      // streaming Response so clients can read them. Elysia skips ctx.set.headers
      // when the handler returns a raw Response.
      const responseHeaders: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }
      for (const [key, value] of Object.entries(ctx.set.headers)) {
        if (value != null) {
          responseHeaders[key] = String(value)
        }
      }

      return new Response(stream, { headers: responseHeaders })
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
