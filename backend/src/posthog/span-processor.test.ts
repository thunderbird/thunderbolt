/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { describe, expect, it } from 'bun:test'
import { createPostHogSpanProcessor } from './span-processor'

const contentKeys = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]

/** PostHog processor first, then an unfiltered exporter that sees what other processors get. */
const setUp = () => {
  const exporter = new InMemorySpanExporter()
  const rawExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': 'Elysia',
      'host.name': 'prod-host-1',
      'process.command_args': ['bun', 'src/index.ts', '--secret'],
      'deployment.environment': 'production',
    }),
    spanProcessors: [createPostHogSpanProcessor(exporter), new SimpleSpanProcessor(rawExporter)],
  })
  return { exporter, rawExporter, provider, tracer: provider.getTracer('test') }
}

describe('createPostHogSpanProcessor', () => {
  it('forwards only spans that carry gen_ai.operation.name', async () => {
    const { exporter, provider, tracer } = setUp()

    tracer.startSpan('Root', { attributes: { 'http.route': '/v1/chat' } }).end()
    tracer.startSpan('chat claude-opus-5', { attributes: { 'gen_ai.operation.name': 'chat' } }).end()
    await provider.forceFlush()

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['chat claude-opus-5'])
  })

  it('strips attributes outside the allowlist without mutating the span other processors see', async () => {
    const { exporter, rawExporter, provider, tracer } = setUp()
    const attributes = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.usage.input_tokens': 12,
      'http.url': 'https://example.com/?q=secret',
    }
    tracer.startSpan('chat claude-opus-5', { attributes }).end()
    await provider.forceFlush()

    const [exported] = exporter.getFinishedSpans()
    const [raw] = rawExporter.getFinishedSpans()
    expect(exported.attributes).toEqual({ 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 12 })
    expect(exported.spanContext()).toEqual(raw.spanContext())
    expect(raw.attributes).toEqual(attributes)
  })

  it.each(contentKeys)('strips the content attribute %s', async (key) => {
    const { exporter, provider, tracer } = setUp()
    tracer.startSpan('chat claude-opus-5', { attributes: { 'gen_ai.operation.name': 'chat', [key]: 'secret' } }).end()
    await provider.forceFlush()

    expect(Object.keys(exporter.getFinishedSpans()[0].attributes)).toEqual(['gen_ai.operation.name'])
  })

  it('replaces the detected resource with service.name only', async () => {
    const { exporter, provider, tracer } = setUp()
    tracer.startSpan('chat claude-opus-5', { attributes: { 'gen_ai.operation.name': 'chat' } }).end()
    await provider.forceFlush()

    const resourceKeys = Object.keys(exporter.getFinishedSpans()[0].resource.attributes)
    expect(resourceKeys).toEqual(['service.name'])
    expect(resourceKeys.filter((key) => key.startsWith('process.') || key.startsWith('host.'))).toEqual([])
  })
})
