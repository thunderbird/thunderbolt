/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { elapsedMs } from '@/utils/timing'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, defaultTextMapGetter, type Tracer } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { genAiAttributes as attr, genAiOperationChat } from '@shared/telemetry/gen-ai'
import type { InferenceProvider } from './client'
import type { InferenceErrorKind } from './error-kind'
import { calculateInferenceCost, type InferencePrice, type InferenceTokenCounts } from './usage-ledger'

const traceContextPropagator = new W3CTraceContextPropagator()

type GenerationSpanOptions = {
  tracer: Tracer
  headers: Headers
  /** Doubles as `gen_ai.provider.name`: `anthropic` is the semconv value; others have none, so the internal name is used. */
  provider: InferenceProvider
  model: string
  price: InferencePrice
  route: string
  host: string
  userId: string
}

type GenerationChunk = {
  responseModel?: string
  finishReason?: string | null
  cacheReadTokens?: number
  reasoningTokens?: number
}

/**
 * Start the GenAI client span for one managed upstream call. Its only possible parent is a valid W3C
 * `traceparent` sent by the caller: the Elysia HTTP span is skipped because PostHog drops non-GenAI
 * spans, which would leave the generation pointing at a missing parent.
 */
export const startGenerationSpan = ({
  tracer,
  headers,
  provider,
  model,
  price,
  route,
  host,
  userId,
}: GenerationSpanOptions) => {
  const parent = traceContextPropagator.extract(ROOT_CONTEXT, Object.fromEntries(headers), defaultTextMapGetter)
  const span = tracer.startSpan(
    `${genAiOperationChat} ${model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [attr.operationName]: genAiOperationChat,
        [attr.providerName]: provider,
        [attr.requestModel]: model,
        [attr.requestStream]: true,
        [attr.serverAddress]: host,
        [attr.posthogDistinctId]: userId,
        // input_tokens already includes cached tokens.
        [attr.posthogCacheReportingExclusive]: false,
        [attr.thunderboltEndpoint]: route,
      },
    },
    parent,
  )
  const startedAt = performance.now()
  let isFirstChunk = true

  return {
    observeChunk: ({ responseModel, finishReason, cacheReadTokens, reasoningTokens }: GenerationChunk) => {
      if (isFirstChunk) {
        isFirstChunk = false
        span.setAttribute(attr.responseTimeToFirstChunk, elapsedMs(startedAt, performance.now()) / 1000)
      }
      span.setAttributes({
        [attr.responseModel]: responseModel,
        [attr.responseFinishReasons]: finishReason ? [finishReason] : undefined,
        [attr.usageCacheReadInputTokens]: cacheReadTokens,
        [attr.usageReasoningOutputTokens]: reasoningTokens,
      })
    },
    /** End the span, attaching usage and ledger cost when the upstream reported usage. */
    end: (counts?: InferenceTokenCounts) => {
      try {
        if (counts) {
          span.setAttributes({
            [attr.usageInputTokens]: counts.promptTokens,
            [attr.usageOutputTokens]: counts.completionTokens,
            [attr.usageCacheReadInputTokens]: counts.cacheReadTokens,
            [attr.usageCacheWriteInputTokens]: counts.cacheCreationTokens,
            // PostHog still prices cache writes from the pre-rename attribute.
            [attr.usageCacheCreationInputTokens]: counts.cacheCreationTokens,
          })
          span.setAttribute(attr.posthogTotalCostUsd, Number(calculateInferenceCost(counts, price)) / 1e9)
        }
      } finally {
        span.end()
      }
    },
    /** End the span as failed, recording only the error class, never provider text. */
    fail: (errorKind: InferenceErrorKind) => {
      span.setAttribute(attr.errorType, errorKind)
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
    },
  }
}
