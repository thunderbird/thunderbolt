import { getSettings } from '@/config/settings'
import { getPostHogClient, isAnalyticsConfigured } from '@/services/analytics'
import { OpenAI } from '@posthog/ai'
import { Elysia } from 'elysia'

/**
 * OpenAI/Fireworks AI proxy routes
 */
export const createOpenAIRoutes = () => {
  const settings = getSettings()

  // Initialize PostHog client for LLM analytics
  const phClient = new PostHog('phc_l0y1VCiPReRyl6rn2bqqSGJ0QNfws5x6mxGhiURyYqW', {
    host: 'https://us.i.posthog.com',
    privacyMode: true,
  })

  // Configure OpenAI client with PostHog analytics and Fireworks API
  const openai = new OpenAI({
    apiKey: settings.fireworksApiKey,
    baseURL: 'https://api.fireworks.ai/inference/v1',
    posthog: phClient,
  })

  return new Elysia().post('/openai/chat/completions', async (ctx) => {
    const body = await ctx.request.json()

    if (!body.stream) {
      throw new Error('Non-streaming requests are not supported')
    }

    if (!settings.fireworksApiKey) {
      ctx.set.status = 500
      throw new Error('Fireworks API key not configured')
    }

    try {
      // Create streaming completion with PostHog analytics
      const completion = await openai.chat.completions.create({
        model: `accounts/fireworks/models/${body.model}`,
        messages: body.messages,
        temperature: body.temperature,
        tools: body.tools,
        tool_choice: body.tool_choice,
        stream: true,
        posthogProperties: {
          privacy_mode: true,
          model_provider: 'fireworks',
          endpoint: '/openai/chat/completions',
          has_tools: !!body.tools,
          temperature: body.temperature,
          // @todo add distinct id and trace id
        },
      })

      const encoder = new TextEncoder()
      let lastUsage: any = null

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of completion) {
              // Track usage data if present
              if (chunk.usage) {
                lastUsage = chunk.usage
              }

              // Convert chunk back to SSE format for client compatibility
              const sseChunk = `data: ${JSON.stringify(chunk)}\n\n`
              controller.enqueue(encoder.encode(sseChunk))
            }

            // Send [DONE] message
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))

            // Log usage if captured (PostHog will also capture this automatically)
            if (lastUsage) {
              console.log('Fireworks usage', {
                model: body.model,
                usage: lastUsage,
                analytics: 'captured by PostHog',
              })
            }

            controller.close()
          } catch (error) {
            console.error('OpenAI streaming error:', error)
            controller.error(error)
          }
        },
      })

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

  // Note: PostHog client should be shutdown on application termination
  // Call phClient.shutdown() in your app's shutdown handler for proper cleanup
}
