import { opentelemetry } from '@elysiajs/opentelemetry'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'

/**
 * Get the OpenTelemetry exporter configuration based on environment variables
 */
const getOtelExporter = () => {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  if (!otlpEndpoint) {
    return null
  }

  return new OTLPTraceExporter({
    url: otlpEndpoint,
    headers: process.env.OTEL_EXPORTER_OTLP_TOKEN
      ? {
          Authorization: `Bearer ${process.env.OTEL_EXPORTER_OTLP_TOKEN}`,
        }
      : undefined,
  })
}

/**
 * Create OpenTelemetry instrumentation plugin for Elysia
 * This must be initialized before other modules are imported
 */
export const createInstrumentation = () => {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const exporter = getOtelExporter()

  if (!exporter) {
    // Return a no-op plugin if OpenTelemetry is not configured
    return null
  }

  console.log(`📊 OpenTelemetry traces exporting to: ${otlpEndpoint}`)

  return opentelemetry({
    spanProcessors: [new BatchSpanProcessor(exporter)],
    instrumentations: [],
  })
}

export const instrumentation = createInstrumentation()
