/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * OpenTelemetry instrumentation for Elysia.
 *
 * Preloaded via bunfig.toml so the SDK initializes before other modules.
 * Uses dynamic imports so OTEL packages are only loaded when configured.
 *
 * Uses process.env instead of Bun.env for consistency with the OTEL SDK
 * packages, which read OTEL_* env vars via process.env internally.
 */

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

export const instrumentation = otlpEndpoint
  ? await (async () => {
      const [{ opentelemetry }, { OTLPTraceExporter }, { BatchSpanProcessor }] = await Promise.all([
        import('@elysiajs/opentelemetry'),
        import('@opentelemetry/exporter-trace-otlp-proto'),
        import('@opentelemetry/sdk-trace-node'),
      ])

      const exporter = new OTLPTraceExporter({
        url: otlpEndpoint,
        headers: process.env.OTEL_EXPORTER_OTLP_TOKEN
          ? { Authorization: `Bearer ${process.env.OTEL_EXPORTER_OTLP_TOKEN}` }
          : undefined,
      })

      console.log(`📊 OpenTelemetry traces exporting to: ${otlpEndpoint}`)

      return opentelemetry({
        spanProcessors: [new BatchSpanProcessor(exporter)],
        instrumentations: [],
      })
    })()
  : null
