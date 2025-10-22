import type { Stream } from 'openai/streaming'

type ChatCompletionChunk = {
  usage?: any
  [key: string]: any
}

/**
 * Creates a ReadableStream from an OpenAI completion stream with SSE formatting
 * @param completion - The OpenAI completion stream
 * @param model - Model name for logging purposes
 * @returns ReadableStream formatted for Server-Sent Events
 */
export const createSSEStreamFromCompletion = (
  completion: Stream<ChatCompletionChunk>,
  model: string,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let lastUsage: any = null
  let isCancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of completion) {
          // Stop processing if client disconnected
          if (isCancelled) {
            break
          }

          // Track usage data if present
          if (chunk.usage) {
            lastUsage = chunk.usage
          }

          // Convert chunk back to SSE format for client compatibility
          const sseChunk = `data: ${JSON.stringify(chunk)}\n\n`

          try {
            controller.enqueue(encoder.encode(sseChunk))
          } catch (enqueueError) {
            // Controller already closed (client disconnected)
            break
          }
        }

        // Send [DONE] message if not cancelled
        if (!isCancelled) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // Ignore if controller is closed
          }
        }

        // Log usage if captured (PostHog will also capture this automatically)
        if (lastUsage) {
          // console.log('Fireworks usage', {
          //   model,
          //   usage: lastUsage,
          //   analytics: 'captured by PostHog',
          // })
        }

        if (controller.desiredSize !== null) {
          controller.close()
        }
      } catch (error) {
        if (!isCancelled) {
          console.error('OpenAI streaming error:', error)
          controller.error(error)
        }
      }
    },
    cancel() {
      // Mark as cancelled to stop processing chunks
      isCancelled = true
      // Abort the OpenAI stream
      completion.controller?.abort()
    },
  })
}
