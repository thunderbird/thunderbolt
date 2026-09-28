/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache, getSettings } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { createTestDb } from '@/test-utils/db'
import { mockAuth } from '@/test-utils/mock-auth'
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import type OpenAI from 'openai'
import { clearInferenceClientCache, getAnthropicMessagesClient, getInferenceClient } from './client'
import { createInferenceRoutes } from './routes'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']

const nativeSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"cache_creation":{"ephemeral_1h_input_tokens":5,"ephemeral_5m_input_tokens":15}}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":4,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const nativeEvents = nativeSse
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6)) as unknown)

const createNativeStream = () => ({
  controller: new AbortController(),
  [Symbol.asyncIterator]: async function* () {
    yield* nativeEvents
  },
})

describe('POST /chat/v1/messages', () => {
  let database: TestDatabase
  let cleanup: () => Promise<void>

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
  })

  afterEach(async () => {
    await cleanup()
  })

  it('forces automatic caching on the native request and records all input usage', async () => {
    const create = mock(async () => createNativeStream())
    const app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        captureInferenceErrorFn: () => {},
        getMessagesClient: () => ({ messages: { create } }) as never,
      }),
    )
    const requestBody = {
      model: 'opus-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello' }],
      system: [{ type: 'text', text: 'System prompt' }],
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' } }],
      stream: true,
    }

    const response = await app.handle(
      new Request('http://localhost/chat/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(nativeSse)
    expect(create).toHaveBeenCalledWith({
      model: 'claude-opus-5',
      max_tokens: 4096,
      messages: requestBody.messages,
      stream: true,
      cache_control: { type: 'ephemeral' },
      system: requestBody.system,
      tools: requestBody.tools,
      thinking: undefined,
      output_config: undefined,
      tool_choice: undefined,
      stop_sequences: undefined,
    })

    const rows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.userId, 'test-user'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5',
      promptTokens: 60,
      completionTokens: 4,
      totalTokens: 64,
      costNanoUsd: 308_750n,
    })
  })

  it.each(['{', 'null'])('returns 400 for invalid JSON body %s without calling upstream', async (body) => {
    const fetchFn = Object.assign(
      mock(async () => {
        throw new Error('must not reach upstream')
      }),
      { preconnect: () => undefined },
    )
    const app = new Elysia().use(createInferenceRoutes({ auth: mockAuth, database, fetchFn }))
    const response = await app.handle(
      new Request('http://localhost/chat/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
      }),
    )

    expect(response.status).toBe(400)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects Anthropic server tools before using the managed API key', async () => {
    const create = mock(() => {
      throw new Error('must not reach Anthropic')
    })
    const app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        captureInferenceErrorFn: () => {},
        getMessagesClient: () => ({ messages: { create } }) as never,
      }),
    )

    const response = await app.handle(
      new Request('http://localhost/chat/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'opus-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'Search the web' }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          stream: true,
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })

  it('preserves Anthropic API status and structured error telemetry', async () => {
    const captureInferenceErrorFn = mock(() => {})
    const error = new AnthropicAPIError(
      429,
      { type: 'rate_limit_error' },
      'rate limited',
      new Headers({ 'request-id': 'req_123' }),
      'rate_limit_error',
    )
    const app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        captureInferenceErrorFn,
        getMessagesClient: () =>
          ({
            messages: {
              create: async () => Promise.reject(error),
            },
          }) as never,
      }),
    )

    const response = await app.handle(
      new Request('http://localhost/chat/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'opus-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      }),
    )

    expect(response.status).toBe(429)
    expect(captureInferenceErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        model: 'opus-5',
        errorKind: 'rate_limit',
        errorType: 'rate_limit_error',
        requestId: 'req_123',
      }),
    )
  })

  it('keeps structured error telemetry for failures raised mid-stream', async () => {
    const captureInferenceErrorFn = mock(() => {})
    const error = new AnthropicAPIError(
      529,
      { type: 'overloaded_error' },
      'overloaded',
      new Headers({ 'request-id': 'req_456' }),
      'overloaded_error',
    )
    const failingStream = {
      controller: new AbortController(),
      [Symbol.asyncIterator]: async function* () {
        yield nativeEvents[0]
        throw error
      },
    }
    const app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        captureInferenceErrorFn,
        getMessagesClient: () => ({ messages: { create: async () => failingStream } }) as never,
      }),
    )

    const response = await app.handle(
      new Request('http://localhost/chat/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'opus-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toBe(error)
    expect(captureInferenceErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'stream',
        status: 529,
        errorKind: 'upstream_error',
        errorType: 'overloaded_error',
        requestId: 'req_456',
      }),
    )
  })
})

describe('Anthropic client API roots', () => {
  const savedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    clearSettingsCache()
    clearInferenceClientCache()
  })

  it.each(['https://anthropic.test', 'https://anthropic.test/'])(
    'uses settings root %s for both protocols',
    async (root) => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
      process.env.ANTHROPIC_BASE_URL = root
      clearSettingsCache()
      getSettings()
      // The SDK must use the resolved settings, even if the environment later changes.
      process.env.ANTHROPIC_BASE_URL = 'https://wrong.test'
      const urls: string[] = []
      const fetchFn: typeof fetch = Object.assign(
        async (input: RequestInfo | URL) => {
          urls.push(input instanceof Request ? input.url : input.toString())
          return Response.json({ id: 'test-response' })
        },
        { preconnect: globalThis.fetch.preconnect },
      )
      const messages = getAnthropicMessagesClient({ fetchFn })
      await messages.messages.create({
        model: 'claude-opus-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello' }],
      })
      const { client } = getInferenceClient('anthropic', { fetchFn })
      await (client as OpenAI).chat.completions.create({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'Hello' }],
      })
      expect(urls).toEqual(['https://anthropic.test/v1/messages', 'https://anthropic.test/v1/chat/completions'])
    },
  )
})
