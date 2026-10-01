/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { createPostHogSpanProcessor } from '@/posthog/span-processor'
import { createTestDb } from '@/test-utils/db'
import { mockAuth } from '@/test-utils/mock-auth'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node'
import { genAiAttributeAllowlist } from '@shared/telemetry/gen-ai'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { clearInferenceClientCache, type InferenceLogger } from './client'
import { createInferenceRoutes } from './routes'

type Protocol = 'openai' | 'anthropic'
type ChunkFields = Pick<ChatCompletionChunk, 'choices'> & Partial<Pick<ChatCompletionChunk, 'usage'>>
type UpstreamReply = (signal: AbortSignal | null | undefined) => Response

const secret = 'ROUTE_TELEMETRY_SECRET'
const contentKeys = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]
const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
const parentSpanId = '00f067aa0ba902b7'
const encoder = new TextEncoder()

const openAiChunk = (fields: ChunkFields): ChatCompletionChunk => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'claude-opus-5',
  ...fields,
})
const openAiSse = (chunks: ChatCompletionChunk[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
const anthropicSse = <Event extends { type: string }>(events: Event[]) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

const openAiContent = openAiChunk({ choices: [{ index: 0, delta: { content: secret }, finish_reason: null }] })
const openAiSuccess = openAiSse([
  openAiContent,
  openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  openAiChunk({
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }),
])

const anthropicStart = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 4, cache_read_input_tokens: 8 },
  },
}
const anthropicDelta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: secret } }
const anthropicSuccess = anthropicSse([
  anthropicStart,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  anthropicDelta,
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
])

const streamReply =
  (body: string): UpstreamReply =>
  () =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

/** A provider 400 whose message echoes the prompt, as real providers sometimes do. */
const errorReply: UpstreamReply = () =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: secret } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })

/** Send `head` then hold the stream open until the SDK aborts the upstream request. */
const hangingReply =
  (head: string): UpstreamReply =>
  (signal) =>
    new Response(
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(encoder.encode(head))
          signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )

/** Everything a span could carry to PostHog, as plain data. */
const snapshot = (span: ReadableSpan) =>
  JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })

describe('Inference routes - GenAI spans and PostHog privacy', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let originalAnthropicKey: string | undefined
  let exporter: InMemorySpanExporter
  let rawExporter: InMemorySpanExporter
  let provider: BasicTracerProvider

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    await database.insert(user).values({
      id: 'test-user',
      name: 'Test User',
      email: 'test-user@example.com',
      emailVerified: true,
      isAnonymous: false,
    })
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    clearSettingsCache()
    clearInferenceClientCache()
    exporter = new InMemorySpanExporter()
    rawExporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({
      spanProcessors: [createPostHogSpanProcessor(exporter), new SimpleSpanProcessor(rawExporter)],
    })
  })

  afterEach(async () => {
    await cleanup()
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey
    }
    clearSettingsCache()
    clearInferenceClientCache()
  })

  /** Serve `reply` as the only upstream through the real SDK clients. */
  const createApp = (reply: UpstreamReply, logger?: InferenceLogger) =>
    new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        captureInferenceErrorFn: () => {},
        fetchFn: Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => reply(init?.signal), {
          preconnect: () => undefined,
        }),
        logger,
        tracer: provider.getTracer('test'),
      }),
    )

  const post = (app: ReturnType<typeof createApp>, protocol: Protocol, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://localhost/chat/${protocol === 'openai' ? 'completions' : 'v1/messages'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          model: 'opus-5',
          max_tokens: 1024,
          system: secret,
          messages: [{ role: 'user', content: secret }],
          tools: [{ name: secret, type: 'custom', input_schema: { type: 'object' } }],
          stream: true,
        }),
      }),
    )

  /** The PostHog-bound spans, after checking the route set nothing outside the allowlist. */
  const exportedSpans = async () => {
    await provider.forceFlush()
    for (const span of rawExporter.getFinishedSpans()) {
      expect(Object.keys(span.attributes).filter((key) => !genAiAttributeAllowlist.has(key))).toEqual([])
      expect(snapshot(span)).not.toContain(secret)
    }
    const spans = exporter.getFinishedSpans()
    for (const span of spans) {
      expect(Object.keys(span.attributes).filter((key) => contentKeys.includes(key))).toEqual([])
    }
    return spans
  }

  const ledgerCostUsd = async () => {
    const [row] = await database.select().from(inferenceUsage)
    return Number(row.costNanoUsd) / 1e9
  }

  it('emits one chat span with usage, identity, and ledger cost for the OpenAI-shaped route', async () => {
    const response = await post(createApp(streamReply(openAiSuccess)), 'openai')
    expect(response.status).toBe(200)
    await response.text()

    const [span, ...rest] = await exportedSpans()
    expect(rest).toEqual([])
    expect(span.name).toBe('chat claude-opus-5')
    expect(span.kind).toBe(SpanKind.CLIENT)
    expect(span.parentSpanContext).toBeUndefined()
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-opus-5',
      'gen_ai.request.stream': true,
      'gen_ai.response.model': 'claude-opus-5',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.time_to_first_chunk': expect.any(Number),
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.cache_read.input_tokens': 8,
      'gen_ai.usage.reasoning.output_tokens': 2,
      'server.address': 'api.anthropic.com',
      'posthog.distinct_id': 'test-user',
      $ai_cache_reporting_exclusive: false,
      $ai_total_cost_usd: await ledgerCostUsd(),
      'thunderbolt.endpoint': '/chat/completions',
    })
  })

  it('emits one chat span with cache reads, cache writes, and summed input for the Anthropic route', async () => {
    const response = await post(createApp(streamReply(anthropicSuccess)), 'anthropic')
    expect(response.status).toBe(200)
    await response.text()

    const [span, ...rest] = await exportedSpans()
    expect(rest).toEqual([])
    expect(span.name).toBe('chat claude-opus-5')
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-opus-5',
      'gen_ai.request.stream': true,
      'gen_ai.response.model': 'claude-opus-5',
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.response.time_to_first_chunk': expect.any(Number),
      'gen_ai.usage.input_tokens': 14,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.cache_read.input_tokens': 8,
      'gen_ai.usage.cache_write.input_tokens': 4,
      'gen_ai.usage.cache_creation.input_tokens': 4,
      'server.address': 'api.anthropic.com',
      'posthog.distinct_id': 'test-user',
      $ai_cache_reporting_exclusive: false,
      $ai_total_cost_usd: await ledgerCostUsd(),
      'thunderbolt.endpoint': '/chat/v1/messages',
    })
  })

  it.each(['openai', 'anthropic'] as const)(
    'records only the error class, never provider text, when the %s upstream fails',
    async (protocol) => {
      const response = await post(createApp(errorReply), protocol)
      expect(response.status).toBe(400)

      const [span] = await exportedSpans()
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR })
      expect(span.attributes['error.type']).toBe('bad_request')
      expect(snapshot(span)).not.toContain(secret)
      expect(await database.select().from(inferenceUsage)).toEqual([])
    },
  )

  it.each(['openai', 'anthropic'] as const)('parents the %s span on a valid W3C traceparent', async (protocol) => {
    const response = await post(
      createApp(streamReply(protocol === 'openai' ? openAiSuccess : anthropicSuccess)),
      protocol,
      {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
      },
    )
    await response.text()

    const [span] = await exportedSpans()
    expect(span.spanContext().traceId).toBe(traceId)
    expect(span.parentSpanContext).toMatchObject({ traceId, spanId: parentSpanId, isRemote: true })
  })

  it.each(['not-a-traceparent', `00-${'0'.repeat(32)}-${parentSpanId}-01`, `ff-${traceId}-${parentSpanId}-01`])(
    'ignores an invalid traceparent %s',
    async (traceparent) => {
      const response = await post(createApp(streamReply(openAiSuccess)), 'openai', { traceparent })
      await response.text()

      const [span] = await exportedSpans()
      expect(span.parentSpanContext).toBeUndefined()
      expect(span.spanContext().traceId).not.toBe(traceId)
    },
  )

  it('ends the Anthropic span with partial usage when the client cancels', async () => {
    const completed = Promise.withResolvers<void>()
    const logger: InferenceLogger = {
      info: (context) => {
        if (context.event === 'inference_usage_completed') {
          completed.resolve()
        }
      },
    }
    const response = await post(
      createApp(hangingReply(anthropicSse([anthropicStart, anthropicDelta])), logger),
      'anthropic',
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await completed.promise

    const [span] = await exportedSpans()
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
    expect(span.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 14,
      'gen_ai.usage.output_tokens': 1,
      'gen_ai.response.model': 'claude-opus-5',
    })
  })

  it('ends the OpenAI-shaped span without usage when the client cancels', async () => {
    const response = await post(createApp(hangingReply(`data: ${JSON.stringify(openAiContent)}\n\n`)), 'openai')
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    const [span] = await exportedSpans()
    expect(span.attributes['gen_ai.response.model']).toBe('claude-opus-5')
    expect(span.attributes['gen_ai.usage.input_tokens']).toBeUndefined()
  })
})
