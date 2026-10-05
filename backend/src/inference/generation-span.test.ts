/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { describe, expect, it } from 'bun:test'
import { startGenerationSpan } from './generation-span'
import { InferenceTokenCountOutOfRangeError } from './usage-ledger'

describe('startGenerationSpan', () => {
  it('still ends the span with usage when the cost calculation throws', () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    const generation = startGenerationSpan({
      tracer: provider.getTracer('test'),
      headers: new Headers(),
      provider: 'anthropic',
      model: 'claude-opus-5',
      price: { provider: 'anthropic', model: 'claude-opus-5', inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n },
      route: '/chat/v1/messages',
      host: 'api.anthropic.com',
      userId: 'user-1',
    })

    // More cache reads than prompt tokens is out of range for the cost calculation.
    expect(() => generation.end({ promptTokens: 1, completionTokens: 2, totalTokens: 3, cacheReadTokens: 5 })).toThrow(
      InferenceTokenCountOutOfRangeError,
    )

    const [span] = exporter.getFinishedSpans()
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(2)
    expect(span.attributes['$ai_total_cost_usd']).toBeUndefined()
  })
})
