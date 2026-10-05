/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import type {
  checkManagedInferenceAdmission,
  InferenceDatabase,
  InferencePrice,
  recordInferenceUsage,
} from '@/inference/usage-ledger'
import { createMockAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { maxRequestBytes } from './history'
import { agentMaxOutputTokens, createAgentRoutes } from './routes'

type CheckAdmission = typeof checkManagedInferenceAdmission

const price: InferencePrice = {
  provider: 'anthropic',
  model: 'claude-test',
  inputNanoUsdPerToken: 1n,
  outputNanoUsdPerToken: 2n,
}
const allowed: CheckAdmission = async () => ({ outcome: 'allowed', price })
const database = {} as InferenceDatabase

const createModel = () =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hello there' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'end_turn' },
            usage: {
              inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 3, text: 3, reasoning: undefined },
            },
          },
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

describe('createAgentRoutes', () => {
  let model: MockLanguageModelV3
  let checkAdmission: ReturnType<typeof mock<CheckAdmission>>
  let recordUsage: ReturnType<typeof mock<typeof recordInferenceUsage>>

  const createApp = async ({ auth = mockAuth, settings = {} }: { auth?: Auth; settings?: Partial<Settings> } = {}) =>
    new Elysia().use(
      await createAgentRoutes({
        auth,
        database,
        settings: createTestSettings({
          agentEnabled: true,
          agentModel: 'claude-test',
          agentSystemPrompt: 'You are the deployment agent.',
          ...settings,
        }),
        model,
        checkAdmission,
        recordUsage,
      }),
    )

  beforeEach(() => {
    model = createModel()
    checkAdmission = mock(allowed)
    recordUsage = mock(async () => 'inserted' as const)
  })

  it('mounts no route when AGENT_ENABLED is off', async () => {
    const app = await createApp({ settings: { agentEnabled: false } })
    expect((await postChat(app)).status).toBe(404)
  })

  it('refuses to start enabled without AGENT_MODEL', async () => {
    expect(createApp({ settings: { agentModel: '' } })).rejects.toThrow('AGENT_MODEL')
  })

  it('requires a session', async () => {
    const app = await createApp({ auth: mockAuthUnauthenticated })
    expect((await postChat(app)).status).toBe(401)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('rejects an invalid history before admission or the model call', async () => {
    const app = await createApp()
    const response = await postChat(app, chatBody([{ id: 'm1', role: 'user', parts: [{ type: 'data-x' }] }]))
    expect(response.status).toBe(400)
    expect(checkAdmission).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('returns 413 for an oversized body', async () => {
    const app = await createApp()
    const text = 'x'.repeat(maxRequestBytes + 1)
    const response = await postChat(app, chatBody([{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }]))
    expect(response.status).toBe(413)
  })

  it('returns 413 from Content-Length before reading the body', async () => {
    const app = await createApp()
    const request = new Request('http://localhost/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(maxRequestBytes + 1) },
      body: chatBody(),
    })
    const textSpy = spyOn(request, 'text')
    const response = await app.handle(request)
    expect(response.status).toBe(413)
    expect(textSpy).not.toHaveBeenCalled()
    expect(checkAdmission).not.toHaveBeenCalled()
  })

  it('returns the quota error body when admission refuses', async () => {
    checkAdmission.mockImplementation(async (_db, _identity, _userId, limits) => ({
      outcome: 'quota-exceeded',
      decision: {
        allowed: false,
        exceededWindow: '5h',
        fiveHourSpentNanoUsd: 0n,
        sevenDaySpentNanoUsd: 0n,
        limits,
      },
    }))
    const app = await createApp()
    const response = await postChat(app)
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('checks admission with anonymous limits for anonymous sessions', async () => {
    const app = await createApp({
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
    const app = await createApp()
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
      database,
      expect.objectContaining({
        userId: 'test-user',
        price,
        counts: { promptTokens: 12, completionTokens: 3, totalTokens: 15, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
    ])
  })
})
