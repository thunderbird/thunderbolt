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
  /** Runs once the provider stream is over, after its usage or failure, and before the client's stream ends. */
  onEnd?: () => Promise<void>
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
export const invokeObserverSafely = (observer: (() => void) | undefined): void => {
  try {
    observer?.()
  } catch {
    // Observer failures must not change inference delivery.
  }
}

/**
 * Creates a ReadableStream from an OpenAI completion stream with SSE formatting. A client that leaves does not end
 * the upstream request: the provider reports usage only in its last chunk, so the stream is read to the end and
 * the request is charged what it used, as the Tinfoil route does.
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

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let latestUsage: CompletionUsageSnapshot | undefined
      const send = (text: string) => {
        if (isCancelled) {
          return
        }
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // The client is gone; keep reading for the usage.
        }
      }

      try {
        for await (const chunk of completion) {
          const usage = parseCompletionUsage(chunk.usage)
          if (usage !== undefined) {
            latestUsage = usage
          }
          send(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      } catch (error) {
        // The error is reported even after the client left: the hold stays charged, and this is the only record of why.
        invokeObserverSafely(() => options.onError?.(error))
        await options.onEnd?.()
        if (!isCancelled) {
          controller.error(error)
        }
        return
      }

      if (latestUsage === undefined) {
        invokeObserverSafely(options.onUsageMissing)
      } else {
        try {
          await options.onUsage?.(latestUsage)
        } catch (error) {
          invokeObserverSafely(() => options.onUsageError?.(error))
        }
      }

      await options.onEnd?.()
      send('data: [DONE]\n\n')
      if (!isCancelled && controller.desiredSize !== null) {
        controller.close()
      }
    },
    cancel() {
      isCancelled = true
    },
  })
}
