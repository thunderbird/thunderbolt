/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

type CompletionStream = AsyncIterable<ChatCompletionChunk> & { controller: AbortController }
export type CompletionUsageSnapshot = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
type CreateSSEStreamOptions = {
  onError?: (error: unknown) => void
  onUsage?: (snapshot: CompletionUsageSnapshot) => Promise<void>
  onUsageError?: CreateSSEStreamOptions['onError']
  onUsageMissing?: () => void
}

/** Copies a complete, valid token usage snapshot from a provider chunk. */
const parseCompletionUsage = (usage: ChatCompletionChunk['usage']): CompletionUsageSnapshot | undefined => {
  if (
    usage === null ||
    usage === undefined ||
    !Number.isSafeInteger(usage.prompt_tokens) ||
    usage.prompt_tokens < 0 ||
    !Number.isSafeInteger(usage.completion_tokens) ||
    usage.completion_tokens < 0 ||
    !Number.isSafeInteger(usage.total_tokens) ||
    usage.total_tokens < 0
  ) {
    return undefined
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

/** Invokes an observer without allowing observability failures to alter the response stream. */
const invokeObserverSafely = (observer: (() => void) | undefined): void => {
  try {
    observer?.()
  } catch {
    // Observer failures must not change inference delivery.
  }
}

/**
 * Creates a ReadableStream from an OpenAI completion stream with SSE formatting
 * @param completion - The OpenAI completion stream
 * @param options - Optional stream lifecycle callbacks
 * @returns ReadableStream formatted for Server-Sent Events
 */
export const createSSEStreamFromCompletion = (
  completion: CompletionStream,
  options: CreateSSEStreamOptions = {},
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let isCancelled = false
  let naturalExhaustionObserved = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let latestUsage: CompletionUsageSnapshot | undefined

      try {
        for await (const chunk of completion) {
          if (isCancelled) {
            return
          }

          const usage = parseCompletionUsage(chunk.usage)
          const sseChunk = `data: ${JSON.stringify(chunk)}\n\n`

          try {
            controller.enqueue(encoder.encode(sseChunk))
          } catch {
            return
          }

          if (usage !== undefined) {
            latestUsage = usage
          }
        }

        if (isCancelled) {
          return
        }

        naturalExhaustionObserved = true

        if (latestUsage === undefined) {
          invokeObserverSafely(options.onUsageMissing)
        } else {
          try {
            await options.onUsage?.(latestUsage)
          } catch (error) {
            invokeObserverSafely(() => options.onUsageError?.(error))
          }
        }

        if (!isCancelled) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // Ignore if controller is closed
          }
        }

        if (controller.desiredSize !== null) {
          controller.close()
        }
      } catch (error) {
        if (!isCancelled) {
          invokeObserverSafely(() => options.onError?.(error))
          controller.error(error)
        }
      }
    },
    cancel() {
      isCancelled = true
      if (!naturalExhaustionObserved) {
        completion.controller.abort()
      }
    },
  })
}
