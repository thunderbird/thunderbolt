/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { genAiAttributes, redactGenAiSpan } from '@shared/telemetry/gen-ai'
import { trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  RandomIdGenerator,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { PostHog } from 'posthog-js'
import { v7 as uuidv7 } from 'uuid'

const appResource = resourceFromAttributes({ 'service.name': 'thunderbolt-app' })

type PostHogConsent = Pick<PostHog, 'get_distinct_id' | 'has_opted_out_capturing'>

/**
 * Batch-export our GenAI spans through the PostHog consent switch: nothing leaves while posthog-js
 * is opted out, and spans are redacted to the shared allowlist with a `service.name`-only resource.
 */
export const createAppSpanProcessor = (exporter: SpanExporter, posthog: PostHogConsent): SpanProcessor => {
  const batch = new BatchSpanProcessor(exporter)
  return {
    onStart: (span) => {
      span.setAttribute(genAiAttributes.posthogDistinctId, posthog.get_distinct_id())
    },
    onEnd: (span) => {
      if (posthog.has_opted_out_capturing()) {
        return
      }
      const redacted = redactGenAiSpan(span, appResource)
      if (redacted) {
        batch.onEnd(redacted)
      }
    },
    forceFlush: () => batch.forceFlush(),
    shutdown: () => batch.shutdown(),
  }
}

const randomIds = new RandomIdGenerator()
let provider: BasicTracerProvider | undefined

/**
 * Register the global tracer provider that exports turn and tool spans to PostHog via our proxy.
 * Trace ids are uuidv7s without dashes, the same value `chat_turn_completed` reports as `trace_id`.
 */
export const startTracing = (posthog: PostHogConsent, apiHost: string): void => {
  provider = new BasicTracerProvider({
    idGenerator: {
      generateTraceId: () => uuidv7().replaceAll('-', ''),
      generateSpanId: () => randomIds.generateSpanId(),
    },
    spanProcessors: [createAppSpanProcessor(new OTLPTraceExporter({ url: `${apiHost}/i/v0/ai/otel` }), posthog)],
  })
  trace.setGlobalTracerProvider(provider)
}

/** Shut down the provider (flushing its batch) and unregister it globally. */
export const stopTracing = async (): Promise<void> => {
  await provider?.shutdown()
  provider = undefined
  trace.disable()
}
