/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RawMessageStreamEvent, Usage } from '@anthropic-ai/sdk/resources/messages'
import type { InferenceTokenCounts } from '@/inference/usage-ledger'
import { invokeObserverSafely } from './streaming'

type AnthropicEventStream = AsyncIterable<RawMessageStreamEvent> & { controller: AbortController }

type CreateAnthropicSSEStreamOptions = {
  onError?: (error: unknown) => void
  onUsage?: (snapshot: InferenceTokenCounts) => Promise<void>
  onUsageError?: (error: unknown) => void
  onUsageMissing?: () => void
}

/** Convert native Anthropic usage into the managed-inference accounting shape. */
const usageSnapshot = (usage: Usage): InferenceTokenCounts => {
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  const cacheCreation1hTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const promptTokens = usage.input_tokens + cacheCreationTokens + cacheReadTokens
  return {
    promptTokens,
    completionTokens: usage.output_tokens,
    totalTokens: promptTokens + usage.output_tokens,
    cacheCreationTokens,
    cacheCreation1hTokens,
    cacheReadTokens,
  }
}

/** Re-encode Anthropic SDK events as SSE while observing final usage and errors. */
export const createAnthropicSSEStream = (
  upstream: AnthropicEventStream,
  options: CreateAnthropicSSEStreamOptions = {},
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let isCancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let usage: Usage | undefined
      try {
        for await (const event of upstream) {
          if (isCancelled) {
            return
          }
          if (event.type === 'message_start') {
            usage = event.message.usage
          } else if (event.type === 'message_delta' && usage) {
            usage = {
              ...usage,
              input_tokens: event.usage.input_tokens ?? usage.input_tokens,
              output_tokens: event.usage.output_tokens,
              cache_creation_input_tokens: event.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens,
              cache_read_input_tokens: event.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
            }
          }
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        }

        if (!usage) {
          invokeObserverSafely(options.onUsageMissing)
        } else {
          try {
            await options.onUsage?.(usageSnapshot(usage))
          } catch (error) {
            invokeObserverSafely(() => options.onUsageError?.(error))
          }
        }
        if (!isCancelled) {
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
      upstream.controller.abort()
    },
  })
}
