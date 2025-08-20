import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { generateId } from '@ai-sdk/provider-utils'

/**
 * A simple middleware that ensures proper text-start and text-end events
 * are emitted for text-delta streams. This prevents the "textPart is undefined"
 * error when providers emit only text-delta events.
 */
export const textBoundaryMiddleware: LanguageModelV2Middleware = {
  middlewareVersion: 'v2',
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()

    let currentTextId: string | null = null
    let hasEmittedTextStart = false
    let hasSeenTextStart = false

    const transformStream = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      transform(chunk, controller) {
        if (chunk.type === 'finish') {
          // Emit text-end if we have an active text part that we created
          if (currentTextId && hasEmittedTextStart) {
            controller.enqueue({
              type: 'text-end',
              id: currentTextId,
            })
            currentTextId = null
            hasEmittedTextStart = false
          }
          controller.enqueue(chunk)
          return
        }

        if (chunk.type === 'text-start') {
          // Provider already handles text boundaries properly
          hasSeenTextStart = true
          controller.enqueue(chunk)
          return
        }

        if (chunk.type === 'text-end') {
          // Provider already handles text boundaries properly
          controller.enqueue(chunk)
          return
        }

        if (chunk.type === 'text-delta') {
          // Only intervene if we haven't seen a text-start (orphaned deltas)
          if (!hasSeenTextStart && !currentTextId) {
            currentTextId = generateId()
            controller.enqueue({
              type: 'text-start',
              id: currentTextId,
            })
            hasEmittedTextStart = true

            // Re-emit the delta with our consistent ID
            controller.enqueue({
              type: 'text-delta',
              id: currentTextId,
              delta: chunk.delta,
            })
          } else if (hasEmittedTextStart) {
            // Continue using our ID for subsequent deltas
            controller.enqueue({
              type: 'text-delta',
              id: currentTextId!,
              delta: chunk.delta,
            })
          } else {
            // Provider handles boundaries, pass through unchanged
            controller.enqueue(chunk)
          }
          return
        }

        // Pass through all other events unchanged
        controller.enqueue(chunk)
      },
    })

    return {
      stream: stream.pipeThrough(transformStream),
      ...rest,
    }
  },
}
