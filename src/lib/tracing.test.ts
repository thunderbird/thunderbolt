/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { BasicTracerProvider, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'bun:test'
import { createAppSpanProcessor } from './tracing'

const setUp = (optedOut: boolean) => {
  const exporter = new InMemorySpanExporter()
  const posthog = { get_distinct_id: () => 'anon-1', has_opted_out_capturing: () => optedOut }
  const provider = new BasicTracerProvider({ spanProcessors: [createAppSpanProcessor(exporter, posthog)] })
  /** InMemorySpanExporter acks on a zero-delay timer, which the fake test clock must advance. */
  const flush = async () => {
    const flushed = provider.forceFlush()
    await getClock().tickAsync(0)
    await flushed
  }
  return { exporter, flush, tracer: provider.getTracer('test') }
}

describe('createAppSpanProcessor', () => {
  it('exports only GenAI spans, stripped to the allowlist, with the distinct id and a service.name resource', async () => {
    const { exporter, flush, tracer } = setUp(false)

    tracer.startSpan('fetch', { attributes: { 'http.url': 'https://example.com' } }).end()
    tracer
      .startSpan('execute_tool search', {
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'search',
          'gen_ai.tool.call.arguments': 'secret',
          'gen_ai.tool.call.result': 'secret',
        },
      })
      .end()
    await flush()

    const spans = exporter.getFinishedSpans()
    expect(spans.map((span) => span.attributes)).toEqual([
      { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search', 'posthog.distinct_id': 'anon-1' },
    ])
    expect(spans[0].resource.attributes).toEqual({ 'service.name': 'thunderbolt-app' })
  })

  it('drops every span while posthog-js is opted out', async () => {
    const { exporter, flush, tracer } = setUp(true)

    tracer.startSpan('invoke_agent thunderbolt', { attributes: { 'gen_ai.operation.name': 'invoke_agent' } }).end()
    await flush()

    expect(exporter.getFinishedSpans()).toEqual([])
  })
})
