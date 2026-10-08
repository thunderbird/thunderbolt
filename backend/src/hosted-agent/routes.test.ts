/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import type {
  checkManagedInferenceAdmission,
  InferenceDatabase,
  InferencePrice,
  recordInferenceUsage,
} from '@/inference/usage-ledger'
import { createTestDb } from '@/test-utils/db'
import { cliRegistrationPendingDeviceId } from '@/dal/sessions'
import { createMockAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { getRegisteredProviders, resetAgentProvidersForTesting } from '@/agents/discovery'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  agentMaxOutputTokens,
  createHostedAgentRoutes,
  maxRequestBytes,
  type CreateHostedAgentRoutesOptions,
} from './routes'

type CheckAdmission = typeof checkManagedInferenceAdmission
type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']

const price: InferencePrice = {
  provider: 'anthropic',
  model: 'claude-test',
  inputNanoUsdPerToken: 1n,
  outputNanoUsdPerToken: 2n,
}
const allowed: CheckAdmission = async () => ({ outcome: 'allowed', price })
const fakeDatabase = {} as InferenceDatabase
const defaultUsage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
}

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never
type StreamUsage = Extract<StreamPart, { type: 'finish' }>['usage']

const replyChunks = (usage: StreamUsage = defaultUsage): StreamPart[] => [
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hello there' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
]

const createModel = (usage: StreamUsage = defaultUsage) =>
  new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: replyChunks(usage) }) }),
  })

/** A retryable 529 whose `retry-after-ms: 0` makes the AI SDK's two retries immediate. */
const createOverloadedError = () =>
  new APICallError({
    message: 'echoes the conversation',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: 529,
    responseHeaders: { 'retry-after-ms': '0' },
    isRetryable: true,
  })

/** Let a run's `consumeStream` promise settle, which releases the user's in-flight slot. */
const settleRun = () => Bun.sleep(10)

const chatBody = (messages: unknown[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }]) =>
  JSON.stringify({ id: 'chat-1', messages, trigger: 'submit-message' })

const postChat = (app: Elysia, body = chatBody()) =>
  app.handle(
    new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  )

/** Mount the routes with test settings; anything not overridden falls back to an enabled agent. */
const createApp = (
  options: Partial<Omit<CreateHostedAgentRoutesOptions, 'settings'>> & { settings?: Partial<Settings> } = {},
) =>
  new Elysia().use(
    createHostedAgentRoutes({
      auth: mockAuth,
      database: fakeDatabase,
      model: createModel(),
      ...options,
      settings: createTestSettings({
        agentEnabled: true,
        agentModel: 'claude-test',
        agentSystemPrompt: 'You are the deployment agent.',
        ...options.settings,
      }),
    }),
  )

describe('createHostedAgentRoutes', () => {
  let model: MockLanguageModelV3
  let checkAdmission: ReturnType<typeof mock<CheckAdmission>>
  let recordUsage: ReturnType<typeof mock<typeof recordInferenceUsage>>
  let logger: { error: ReturnType<typeof mock>; info: ReturnType<typeof mock> }

  const createMockedApp = ({ auth = mockAuth, settings = {} }: { auth?: Auth; settings?: Partial<Settings> } = {}) =>
    createApp({ auth, settings, model, checkAdmission, recordUsage, logger })

  beforeEach(() => {
    model = createModel()
    checkAdmission = mock(allowed)
    recordUsage = mock(async () => 'inserted' as const)
    logger = { error: mock(), info: mock() }
  })

  it('mounts no route when AGENT_ENABLED is off', async () => {
    const app = createMockedApp({ settings: { agentEnabled: false } })
    expect((await postChat(app)).status).toBe(404)
  })

  it.each([true, false])('registers its discovery provider when AGENT_ENABLED is %p', (agentEnabled) => {
    resetAgentProvidersForTesting()
    createMockedApp({ settings: { agentEnabled } })
    expect(getRegisteredProviders().map(({ id }) => id)).toEqual(['hosted-agent'])
    resetAgentProvidersForTesting()
  })

  it('refuses to start enabled without AGENT_MODEL', () => {
    expect(() => createMockedApp({ settings: { agentModel: '' } })).toThrow('AGENT_MODEL')
  })

  it('refuses to start enabled without ANTHROPIC_API_KEY when no model is injected', () => {
    expect(() => createApp({ model: undefined, settings: { anthropicApiKey: '' } })).toThrow('ANTHROPIC_API_KEY')
  })

  it('rejects a CLI session that has not finished device registration', async () => {
    const pendingCliAuth = {
      api: {
        getSession: async () => ({
          user: { id: 'cli-user' },
          session: { deviceId: cliRegistrationPendingDeviceId },
        }),
      },
    } as unknown as Auth
    const app = createMockedApp({ auth: pendingCliAuth, settings: { cliDeviceRegistrationEnabled: true } })
    const response = await postChat(app)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'CLI_DEVICE_NOT_BOUND' })
    expect(checkAdmission).not.toHaveBeenCalled()
  })

  it('requires a session', async () => {
    const app = createMockedApp({ auth: mockAuthUnauthenticated })
    expect((await postChat(app)).status).toBe(401)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('rejects an invalid history before admission or the model call', async () => {
    const app = createMockedApp()
    const response = await postChat(app, chatBody([{ id: 'm1', role: 'user', parts: [{ type: 'data-x' }] }]))
    expect(response.status).toBe(400)
    expect(checkAdmission).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it.each([
    ['malformed JSON', new TextEncoder().encode('{"id":"chat-1","messages":[')],
    ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
  ])('returns 400, not 413, for %s and never reaches admission', async (_label, body) => {
    const app = createMockedApp()
    const response = await app.handle(
      new Request('http://localhost/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    )
    expect(response.status).toBe(400)
    expect(checkAdmission).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('sends the default model through fetchFn, labelled as agent traffic', async () => {
    const fetchFn = mock(async (_input: RequestInfo | URL) =>
      Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'stub' } }, { status: 400 }),
    )
    const app = createApp({
      model: undefined,
      fetchFn: fetchFn as unknown as typeof fetch,
      checkAdmission,
      recordUsage,
      logger,
      settings: { anthropicApiKey: 'test-key', anthropicBaseUrl: 'https://anthropic.test' },
    })
    await (await postChat(app)).text()
    await settleRun()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://anthropic.test/v1/messages')
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inference_upstream_attempt', source: 'agent', status: 400 }),
      'Inference upstream attempt',
    )
  })

  it('returns 413 for an oversized body', async () => {
    const app = createMockedApp()
    const text = 'x'.repeat(maxRequestBytes + 1)
    const response = await postChat(app, chatBody([{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }]))
    expect(response.status).toBe(413)
  })

  it('returns 413 from Content-Length before reading the body', async () => {
    const app = createMockedApp()
    const request = new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(maxRequestBytes + 1) },
      body: chatBody(),
    })
    const response = await app.handle(request)
    expect(response.status).toBe(413)
    expect(request.bodyUsed).toBe(false)
    expect(checkAdmission).not.toHaveBeenCalled()
  })

  it('returns the quota error body when admission refuses', async () => {
    checkAdmission.mockImplementation(async (_db, _identity, _userId, limits) => ({
      outcome: 'quota-exceeded',
      decision: { allowed: false, exceededWindow: '5h', fiveHourSpentNanoUsd: 0n, sevenDaySpentNanoUsd: 0n, limits },
    }))
    const app = createMockedApp()
    const response = await postChat(app)
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('returns 503 when the model has no price', async () => {
    checkAdmission.mockImplementation(async () => ({ outcome: 'price-unavailable' }))
    const app = createMockedApp()
    const response = await postChat(app)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('checks admission with anonymous limits for anonymous sessions', async () => {
    const app = createMockedApp({
      auth: createMockAuth('anon-user', true),
      settings: { inferenceQuotaAnonymousFiveHourCents: 7 },
    })
    await (await postChat(app)).text()
    expect(checkAdmission.mock.calls[0].slice(1, 4)).toEqual([
      { provider: 'anthropic', model: 'claude-test' },
      'anon-user',
      expect.objectContaining({ fiveHourCents: 7 }),
    ])
  })

  it('streams a UI message response and records usage', async () => {
    const app = createMockedApp()
    const response = await postChat(
      app,
      chatBody([
        { id: 's', role: 'system', parts: [{ type: 'text', text: 'Client system prompt' }] },
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      ]),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(await response.text()).toContain('"delta":"Hello there"')

    const [call] = model.doStreamCalls
    expect(call.maxOutputTokens).toBe(agentMaxOutputTokens)
    expect(call.prompt).toEqual([
      { role: 'system', content: 'You are the deployment agent.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ])
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0]).toEqual([
      fakeDatabase,
      expect.objectContaining({
        userId: 'test-user',
        price,
        counts: { promptTokens: 12, completionTokens: 3, totalTokens: 15, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
    ])
  })

  it('logs a failed ledger write with a safe message', async () => {
    recordUsage.mockImplementation(async () => {
      throw new Error('insert failed')
    })
    const app = createMockedApp()
    await (await postChat(app)).text()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_usage_record_failed', error: 'insert failed' }),
      'Agent usage record failed',
    )
  })

  it('logs a retried model failure by error name and the last attempt status only', async () => {
    model = new MockLanguageModelV3({
      doStream: async () => {
        throw createOverloadedError()
      },
    })
    const app = createMockedApp()
    await (await postChat(app)).text()
    expect(model.doStreamCalls).toHaveLength(3)
    const [context] = logger.error.mock.calls[0]
    expect(context).toEqual(
      expect.objectContaining({ event: 'agent_stream_failed', errorName: 'AI_RetryError', status: 529 }),
    )
    expect(JSON.stringify(context)).not.toContain('echoes the conversation')
    expect(recordUsage).not.toHaveBeenCalled()
  })

  it('skips the ledger and logs when the provider reports no usage', async () => {
    const noUsage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
    model = new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: replyChunks(noUsage) }) }),
    })
    const app = createMockedApp()
    await (await postChat(app)).text()
    await settleRun()
    expect(recordUsage).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_usage_missing' }),
      'Agent usage missing',
    )
  })

  describe('one run per user', () => {
    it('refuses a second run while the first is still streaming', async () => {
      const gate = Promise.withResolvers<void>()
      model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start: async (controller) => {
              await gate.promise
              replyChunks().forEach((chunk) => controller.enqueue(chunk))
              controller.close()
            },
          }),
        }),
      })
      const app = createMockedApp()

      const first = await postChat(app)
      const second = await postChat(app)
      expect(second.status).toBe(429)
      expect(await second.json()).toEqual({ error: { code: 'AGENT_RUN_IN_PROGRESS' } })

      gate.resolve()
      await first.text()
      await settleRun()
      expect((await postChat(app)).status).toBe(200)
    })

    it('releases the slot after a completed run', async () => {
      const app = createMockedApp()
      await (await postChat(app)).text()
      await settleRun()
      expect((await postChat(app)).status).toBe(200)
    })

    it('times out a provider that never emits, then releases the slot', async () => {
      model = new MockLanguageModelV3({
        // Silent until aborted, the way a fetch-backed provider behaves on a hung connection.
        doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream<StreamPart>({
            start: (controller) => abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason)),
          }),
        }),
      })
      const app = createApp({ model, checkAdmission, recordUsage, logger, upstreamTimeoutMs: 50 })

      const response = await postChat(app)
      // A timed-out run ends the client's stream cleanly, unlike a provider that errors mid-reply.
      await response.text()
      await settleRun()

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'agent_run_timed_out', upstreamTimeoutMs: 50 }),
        'Agent run timed out',
      )
      expect(recordUsage).not.toHaveBeenCalled()
      expect((await postChat(app)).status).toBe(200)
    })

    it('releases the slot after a failed run', async () => {
      model = new MockLanguageModelV3({
        doStream: async () => {
          throw createOverloadedError()
        },
      })
      const app = createMockedApp()
      await (await postChat(app)).text()
      await settleRun()
      const retry = await postChat(app)
      expect(retry.status).toBe(200)
      await retry.text()
    })
  })
})

describe('createHostedAgentRoutes with the usage ledger', () => {
  let database: TestDatabase
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    await database.insert(user).values({
      id: 'test-user',
      name: 'Registered User',
      email: 'test-user@example.com',
      emailVerified: true,
    })
    await database.insert(inferencePrices).values({
      provider: 'anthropic',
      model: 'claude-test',
      inputNanoUsdPerToken: 1000n,
      outputNanoUsdPerToken: 5000n,
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('admits against the real price table and records usage with cache tokens', async () => {
    const app = createApp({
      database,
      model: createModel({
        inputTokens: { total: 160, noCache: 100, cacheRead: 40, cacheWrite: 20 },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      }),
    })

    const response = await postChat(app)
    expect(response.status).toBe(200)
    await response.text()

    const rows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.userId, 'test-user'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-test',
        promptTokens: 160,
        completionTokens: 10,
        totalTokens: 170,
        // 100 uncached x 1000 + 20 cache writes x 1250 + 40 cache reads x 100 + 10 output x 5000
        costNanoUsd: 179_000n,
      }),
    )
  })

  it('logs a provider stream that dies mid-reply and writes no zero-cost row', async () => {
    const logger = { error: mock(), info: mock() }
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<StreamPart>({
          start: (controller) => {
            controller.enqueue({ type: 'text-start', id: 't1' })
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'Hello' })
            controller.error(new Error('socket closed: echoes the conversation'))
          },
        }),
      }),
    })
    const app = createApp({ database, model, logger })

    const response = await postChat(app)
    expect(response.status).toBe(200)
    // The client's stream is cut off too: the AI SDK does not turn a dead provider stream into an error part.
    await expect(response.text()).rejects.toThrow()
    await settleRun()

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_stream_failed', errorName: 'Error', status: undefined }),
      'Agent stream failed',
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('echoes the conversation')
    expect(await database.select().from(inferenceUsage)).toHaveLength(0)
  })
})
