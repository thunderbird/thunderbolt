/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * OpenTelemetry instrumentation for Elysia.
 *
 * Preloaded via bunfig.toml so the SDK initializes before other modules.
 * Uses dynamic imports so OTEL packages are only loaded when configured.
 * One tracer provider feeds the generic OTLP exporter (OTEL_EXPORTER_OTLP_ENDPOINT)
 * and/or PostHog's LLM analytics ingest (POSTHOG_API_KEY, GenAI spans only).
 *
 * Uses process.env instead of Bun.env for consistency with the OTEL SDK
 * packages, which read OTEL_* env vars via process.env internally.
 */

import type { SpanProcessor } from '@opentelemetry/sdk-trace-node'

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const posthogApiKey = process.env.POSTHOG_API_KEY
const posthogHost = process.env.POSTHOG_HOST || 'https://us.i.posthog.com'

/** Every configured span processor; shut these down on exit to flush buffered spans. */
export const spanProcessors: SpanProcessor[] = []

export const instrumentation =
  otlpEndpoint || posthogApiKey
    ? await (async () => {
        const [{ opentelemetry }, { OTLPTraceExporter }, { BatchSpanProcessor }, { createPostHogSpanProcessor }] =
          await Promise.all([
            import('@elysiajs/opentelemetry'),
            import('@opentelemetry/exporter-trace-otlp-proto'),
            import('@opentelemetry/sdk-trace-node'),
            import('@/posthog/span-processor'),
          ])

        if (otlpEndpoint) {
          const exporter = new OTLPTraceExporter({
            url: otlpEndpoint,
            headers: process.env.OTEL_EXPORTER_OTLP_TOKEN
              ? { Authorization: `Bearer ${process.env.OTEL_EXPORTER_OTLP_TOKEN}` }
              : undefined,
          })
          spanProcessors.push(new BatchSpanProcessor(exporter))
          console.log(`📊 OpenTelemetry traces exporting to: ${otlpEndpoint}`)
        }

        if (posthogApiKey) {
          const exporter = new OTLPTraceExporter({
            url: `${posthogHost}/i/v0/ai/otel`,
            headers: { Authorization: `Bearer ${posthogApiKey}` },
          })
          spanProcessors.push(createPostHogSpanProcessor(exporter))
          console.log(`📊 LLM generation spans exporting to PostHog: ${posthogHost}`)
        }

        return opentelemetry({ spanProcessors, instrumentations: [] })
      })()
    : null
