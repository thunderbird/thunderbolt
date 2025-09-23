import { getSettings } from '@/config/settings'
import { Elysia } from 'elysia'
import OpenAI from 'openai'

/**
 * OpenAI/Fireworks AI proxy routes
 */
export const createOpenAIRoutes = () => {
  const settings = getSettings()

  // Configure OpenAI client to use Fireworks API
  const openai = new OpenAI({
    apiKey: settings.fireworksApiKey,
    baseURL: 'https://api.fireworks.ai/inference/v1',
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
      // Create streaming completion
      const completion = await openai.chat.completions.create({
        model: `accounts/fireworks/models/${body.model}`,
        messages: body.messages,
        temperature: body.temperature,
        tools: body.tools,
        tool_choice: body.tool_choice,
        stream: true,
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

            // Log usage if captured
            if (lastUsage) {
              console.log('Fireworks usage', {
                model: body.model,
                usage: lastUsage,
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
}
