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
import { createMockAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
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

const createModel = (usage = defaultUsage) =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hello there' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
        ],
      }),
    }),
  })

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
const createApp = async (
  options: Partial<Omit<CreateHostedAgentRoutesOptions, 'settings'>> & { settings?: Partial<Settings> } = {},
) =>
  new Elysia().use(
    await createHostedAgentRoutes({
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
  let logger: { error: ReturnType<typeof mock> }

  const createMockedApp = ({ auth = mockAuth, settings = {} }: { auth?: Auth; settings?: Partial<Settings> } = {}) =>
    createApp({ auth, settings, model, checkAdmission, recordUsage, logger })

  beforeEach(() => {
    model = createModel()
    checkAdmission = mock(allowed)
    recordUsage = mock(async () => 'inserted' as const)
    logger = { error: mock() }
  })

  it('mounts no route when AGENT_ENABLED is off', async () => {
    const app = await createMockedApp({ settings: { agentEnabled: false } })
    expect((await postChat(app)).status).toBe(404)
  })

  it('refuses to start enabled without AGENT_MODEL', async () => {
    await expect(createMockedApp({ settings: { agentModel: '' } })).rejects.toThrow('AGENT_MODEL')
  })

  it('refuses to start enabled without ANTHROPIC_API_KEY when no model is injected', async () => {
    await expect(createApp({ model: undefined, settings: { anthropicApiKey: '' } })).rejects.toThrow(
      'ANTHROPIC_API_KEY',
    )
  })

  it('requires a session', async () => {
    const app = await createMockedApp({ auth: mockAuthUnauthenticated })
    expect((await postChat(app)).status).toBe(401)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('rejects an invalid history before admission or the model call', async () => {
    const app = await createMockedApp()
    const response = await postChat(app, chatBody([{ id: 'm1', role: 'user', parts: [{ type: 'data-x' }] }]))
    expect(response.status).toBe(400)
    expect(checkAdmission).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('returns 413 for an oversized body', async () => {
    const app = await createMockedApp()
    const text = 'x'.repeat(maxRequestBytes + 1)
    const response = await postChat(app, chatBody([{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }]))
    expect(response.status).toBe(413)
  })

  it('returns 413 from Content-Length before reading the body', async () => {
    const app = await createMockedApp()
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
    const app = await createMockedApp()
    const response = await postChat(app)
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('returns 503 when the model has no price', async () => {
    checkAdmission.mockImplementation(async () => ({ outcome: 'price-unavailable' }))
    const app = await createMockedApp()
    const response = await postChat(app)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('checks admission with anonymous limits for anonymous sessions', async () => {
    const app = await createMockedApp({
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
    const app = await createMockedApp()
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
    const app = await createMockedApp()
    await (await postChat(app)).text()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_usage_record_failed', error: 'insert failed' }),
      'Agent usage record failed',
    )
  })

  it('logs a model failure by error name and status only', async () => {
    model = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: 'echoes the conversation',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 529,
          isRetryable: false,
        })
      },
    })
    const app = await createMockedApp()
    await (await postChat(app)).text()
    const [context] = logger.error.mock.calls[0]
    expect(context).toEqual(
      expect.objectContaining({ event: 'agent_stream_failed', errorName: 'AI_APICallError', status: 529 }),
    )
    expect(JSON.stringify(context)).not.toContain('echoes the conversation')
    expect(recordUsage).not.toHaveBeenCalled()
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
    const app = await createApp({
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
})
