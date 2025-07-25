import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import type { TransformStreamDefaultController } from 'stream/web'

/**
 * Middleware that handles reasoning content provided via a "reasoning" property
 * in the delta object (as used by some OpenRouter providers like Qwen).
 *
 * This streams reasoning content in real-time as it arrives, then switches
 * to regular text content when the reasoning phase ends.
 */
export const reasoningPropertyParserMiddleware: LanguageModelV2Middleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()

    // State for reasoning streaming
    let inReasoningMode = false

    const transform = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      transform(
        chunk: LanguageModelV2StreamPart,
        controller: TransformStreamDefaultController<LanguageModelV2StreamPart>,
      ) {
        // Fast-path: non-text chunks are forwarded untouched
        if ((chunk as any).type !== 'text') {
          controller.enqueue(chunk)
          return
        }

        const text = (chunk as any).text as string
        const reasoning = (chunk as any).reasoning as string | null

        // If we have reasoning content, we're in reasoning mode
        if (reasoning && reasoning !== '') {
          inReasoningMode = true

          // Emit reasoning content immediately as it arrives
          controller.enqueue({ type: 'reasoning', text: reasoning } as any)
          return
        }

        // If reasoning becomes null but we were in reasoning mode, we're switching to text
        if (reasoning === null && inReasoningMode) {
          inReasoningMode = false
          // The reasoning phase has ended, now we'll process text normally
        }

        // If we have text content, emit it normally
        if (text && typeof text === 'string' && text.length > 0) {
          controller.enqueue({ type: 'text', text } as any)
        }
      },

      flush(_controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) {
        // No need to flush anything since we stream reasoning in real-time
      },
    })

    return { stream: stream.pipeThrough(transform), ...rest }
  },

  wrapGenerate: async ({ doGenerate }) => doGenerate(),
}
