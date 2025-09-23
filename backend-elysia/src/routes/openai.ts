import { getSettings } from '@/config/settings'
import { Elysia } from 'elysia'

/**
 * OpenAI/Fireworks AI proxy routes
 */
export const createOpenAIRoutes = () => {
  const settings = getSettings()

  return new Elysia().post('/openai/chat/completions', async (ctx) => {
    const body = await ctx.request.json()

    if (!body.stream) {
      throw new Error('Non-streaming requests are not supported')
    }

    if (!settings.fireworksApiKey) {
      ctx.set.status = 500
      throw new Error('Fireworks API key not configured')
    }

    const fireworksBody = {
      ...body,
      model: `accounts/fireworks/models/${body.model}`,
    }

    const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.fireworksApiKey}`,
      },
      body: JSON.stringify(fireworksBody),
    })

    if (!response.ok) {
      ctx.set.status = response.status
      throw new Error(`Fireworks API error: ${response.statusText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      ctx.set.status = 502
      throw new Error('Failed to read Fireworks response stream')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let lastUsage: any = null

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          if (lastUsage) {
            console.log('Fireworks usage', {
              model: body.model,
              usage: lastUsage,
            })
          }
          controller.close()
          return
        }

        // Pass-through to client
        controller.enqueue(value!)

        // Parse SSE lines to capture usage if present
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)

          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            if (dataStr && dataStr !== '[DONE]') {
              try {
                const json = JSON.parse(dataStr)
                if (json && json.usage) {
                  lastUsage = json.usage
                }
              } catch (_) {
                // Ignore JSON parse errors on partial lines
              }
            }
          }

          newlineIndex = buffer.indexOf('\n')
        }
      },
      cancel() {
        reader.releaseLock()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })
}
