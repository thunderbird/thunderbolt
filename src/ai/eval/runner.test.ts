/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { initLayout, teardownLayout } from './ui'
import { builtInAgent } from '@/defaults/agents'
import { http } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { AgentAdapter } from '@/types/acp'
import type { Model, ThunderboltUIMessage } from '@/types'
import { defaultModelOpus5 } from '@shared/defaults/models'
import { aggregateEvalMetrics } from './stats'
import { fixtureAttempt, fixtureManifest, fixtureScenario } from './test-fixtures'
import {
  createEvalAdapterContext,
  deterministicVerdicts,
  fetchAndParseTurn,
  recoveredToolEvents,
  runTrial,
  runPool,
  runScenario,
} from './runner'

const model: Model = { ...defaultModelOpus5, apiKey: null }
const proxyFetch: FetchFn = Object.assign(async () => new Response(), {
  preconnect: async () => false,
})
const userMessage = (text: string): ThunderboltUIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
})

const adapterWithFetch = (fetch: AgentAdapter['fetch']): AgentAdapter => ({
  agent: builtInAgent,
  capabilities: null,
  fetch,
  ensureSession: async () => {},
  disconnect: () => {},
})

const contextFor = (messages: ThunderboltUIMessage[]) =>
  createEvalAdapterContext({
    threadId: crypto.randomUUID(),
    selectedModel: model,
    messages,
    httpClient: http,
    getProxyFetch: () => proxyFetch,
  })

/** Create a deterministic timeout scheduler controlled directly by each test. */
const manualTimeout = () => {
  const callbacks: Array<() => void> = []
  return {
    schedule: (callback: () => void) => {
      callbacks.push(callback)
      return () => {}
    },
    fire: () => callbacks[0]?.(),
  }
}

describe('createEvalAdapterContext', () => {
  test('builds each turn budget from the last user message', () => {
    const search = contextFor([userMessage('/research old turn'), userMessage('/search latest turn')])
    const research = contextFor([userMessage('/research latest turn')])
    const chat = contextFor([userMessage('no explicit web skill')])

    expect(search.webToolBudget?.intent).toBe('search')
    expect(research.webToolBudget?.intent).toBe('research')
    expect(chat.webToolBudget?.intent).toBe('auto')
  })
})

describe('fetchAndParseTurn', () => {
  test('aborts an adapter request that does not settle before the timeout', async () => {
    const observed: { signal?: AbortSignal } = {}
    const adapter = adapterWithFetch(
      (init) =>
        new Promise<Response>(() => {
          observed.signal = init.signal ?? undefined
        }),
    )
    const timeout = manualTimeout()

    const turn = fetchAndParseTurn(
      adapter,
      { method: 'POST', body: '{}' },
      contextFor([userMessage('hello')]),
      5,
      timeout.schedule,
    )
    timeout.fire()

    expect(await turn).toMatchObject({ error: 'Scenario timed out', finishReason: 'timeout' })
    expect(observed.signal?.aborted).toBe(true)
  })

  test('cancels stream parsing when the timeout fires', async () => {
    const state = { canceled: false }
    const adapter = adapterWithFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          state.canceled = true
        },
      })
      return new Response(body)
    })
    const timeout = manualTimeout()

    const turn = fetchAndParseTurn(
      adapter,
      { method: 'POST', body: '{}' },
      contextFor([userMessage('hello')]),
      5,
      timeout.schedule,
    )
    timeout.fire()

    expect(await turn).toMatchObject({ error: 'Scenario timed out', finishReason: 'timeout' })
    expect(state.canceled).toBe(true)
  })
})

test('timeout preserves and freezes partial text, tools and error events', async () => {
  const ready = Promise.withResolvers<void>()
  const timeout = manualTimeout()
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"partial answer"}\n'))
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"tool-input-available","toolCallId":"one","toolName":"search","input":{"query":"hello"}}\n',
          ),
        )
      },
      pull: () => {
        ready.resolve()
      },
    },
    { highWaterMark: 0 },
  )
  const operation = fetchAndParseTurn(
    adapterWithFetch(async () => new Response(stream)),
    {},
    contextFor([userMessage('hello')]),
    5,
    timeout.schedule,
  )
  await ready.promise
  timeout.fire()
  const parsed = await operation
  const saved = JSON.stringify(parsed)
  expect(parsed.text).toBe('partial answer')
  expect(parsed.toolCalls).toHaveLength(1)
  expect(parsed.events).toHaveLength(2)
  expect(parsed.finishReason).toBe('timeout')
  await Promise.resolve()
  expect(JSON.stringify(parsed)).toBe(saved)
})

test('generation retry is fresh, retained, and only for unresolved infrastructure failure', async () => {
  const scenario = fixtureScenario()
  const first = fixtureAttempt(scenario, false, 'infra_error')
  const next = fixtureAttempt(scenario)
  const attempts = [first, next]
  const trial = await runTrial(scenario, 0, async () => attempts.shift()!)
  expect(trial.attempts).toEqual([first, next])
  expect(first.threadId).not.toBe(next.threadId)
  for (const status of ['completed', 'timeout', 'judge_error'] as const) {
    const calls: number[] = []
    const attempt = fixtureAttempt(scenario, false, status)
    const result = await runTrial(scenario, 0, async () => {
      calls.push(1)
      return attempt
    })
    expect(result.attempts).toHaveLength(1)
    expect(calls).toHaveLength(1)
  }
})

test('proven deterministic failure blocks generation retry even with a transport error', async () => {
  const scenario = fixtureScenario()
  const attempt = fixtureAttempt(scenario, false, 'infra_error')
  attempt.streams[0].toolCalls.push({ toolName: 'search', toolCallId: 'prohibited' })
  attempt.verdicts = deterministicVerdicts(scenario, attempt.streams[0], false)
  expect(attempt.verdicts).toEqual({ mustProduceOutput: 'unknown', maxToolCalls: 'fail' })
  attempt.provenFailure = true
  const trial = await runTrial(scenario, 0, async () => attempt)
  expect(trial.attempts).toHaveLength(1)
})

test('generation retries never exceed two attempts', async () => {
  const attempt = fixtureAttempt(undefined, false, 'infra_error')
  expect((await runTrial(fixtureScenario(), 0, async () => attempt)).attempts).toHaveLength(2)
})

test('recovered errors distinguish invalid inputs, infrastructure problems and budget denial', () => {
  const stream = fixtureAttempt().streams[0]
  stream.toolCalls = [
    { toolName: 'search', toolCallId: 'search' },
    { toolName: 'fetch_content', toolCallId: 'fetch' },
  ]
  stream.events = [
    { type: 'tool-output-error', toolCallId: 'search', errorText: 'HTTP 503' },
    { type: 'tool-output-error', errorText: 'Invalid arguments: query required' },
    { type: 'tool-output-available', output: { status: 'budget_exhausted' } },
    { type: 'tool-output-available', toolCallId: 'fetch', output: { success: false, error: 'backend unavailable' } },
    { type: 'tool-output-error', toolCallId: 'bash', errorText: 'command exited 1' },
    { type: 'tool-output-available', output: { success: true } },
  ]
  expect(recoveredToolEvents([stream])).toEqual({ toolInfraError: 2, toolMisuse: 1, budgetDenial: 1 })
})

describe('runner integration with an injected offline adapter', () => {
  beforeAll(async () => setupTestDatabase())
  afterAll(async () => teardownTestDatabase())

  test('keeps execution error and proven behavioural failure independent', async () => {
    const adapter = adapterWithFetch(
      async () =>
        new Response(
          [
            { type: 'tool-input-available', toolName: 'search', toolCallId: 'prohibited', input: { query: 'q' } },
            { type: 'error', errorText: 'provider unavailable' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n`)
            .join(''),
        ),
    )
    const attempt = await runScenario(fixtureScenario(), adapter)
    expect(attempt.status).toBe('infra_error')
    expect(attempt.provenFailure).toBe(true)
    expect(attempt.verdicts.maxToolCalls).toBe('fail')
    expect(attempt.streams[0].events).toHaveLength(2)
  })

  test('retains an unclassified adapter exception and stack without retrying it', async () => {
    const calls: number[] = []
    const adapter = adapterWithFetch(async () => {
      calls.push(1)
      throw new Error('adapter invariant broke')
    })
    const trial = await runTrial(fixtureScenario(), 0, () => runScenario(fixtureScenario(), adapter))
    expect(calls).toHaveLength(1)
    expect(trial.attempts[0]).toMatchObject({
      status: 'infra_error',
      unclassified: true,
      error: 'adapter invariant broke',
    })
    expect(trial.attempts[0].errorStack).toContain('adapter invariant broke')
  })

  test('recognized transport errors retry once with a fresh thread', async () => {
    const threads: string[] = []
    const adapter = adapterWithFetch(async (_init, context) => {
      threads.push(context.threadId)
      if (threads.length === 1) {
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
      }
      return new Response('data: {"type":"text-delta","delta":"answer"}\n')
    })
    const trial = await runTrial(fixtureScenario(), 0, () => runScenario(fixtureScenario(), adapter))
    expect(trial.attempts).toHaveLength(2)
    expect(new Set(threads).size).toBe(2)
    expect(trial.attempts[0].unclassified).toBe(false)
    expect(trial.attempts[1].status).toBe('completed')
  })

  test.each([false, true])('I1: setup-only search is excluded from headlines (timeout=%s)', async (timesOut) => {
    const ready = Promise.withResolvers<void>()
    const timeout = manualTimeout()
    const events = [
      { type: 'tool-input-available', toolName: 'search', toolCallId: 'setup-search', input: { query: 'q' } },
      { type: 'tool-output-available', toolCallId: 'setup-search', output: { details: { result: 'setup evidence' } } },
    ]
    const adapter = adapterWithFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start: (controller) => {
                controller.enqueue(
                  new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')),
                )
                if (!timesOut) {
                  controller.close()
                }
              },
              pull: () => {
                ready.resolve()
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    )
    const scenario = { ...fixtureScenario('setup-only', 'multi_turn_reuse'), followUps: ['Reuse the earlier result'] }
    const pending = runScenario(scenario, adapter, (adapter, init, context, timeoutMs) =>
      fetchAndParseTurn(adapter, init, context, timeoutMs, timeout.schedule),
    )
    if (timesOut) {
      await ready.promise
      timeout.fire()
    }
    const attempt = await pending
    expect(attempt.scoredTurnReached).toBe(false)
    expect(attempt.streams[0].toolCalls).toHaveLength(1)
    expect(attempt.result.toolCallCount).toBe(0)
    expect(attempt.result.responseText).toBe('')
    expect(attempt.status).toBe(timesOut ? 'timeout' : 'completed')
    const trial = { id: `${scenario.id}/0`, index: 0, scenario, attempts: [attempt] }
    const group = aggregateEvalMetrics(fixtureManifest([scenario], 1), [trial]).groups['opus/pi']
    expect(group.scenarios[scenario.id]).toMatchObject({ c: 0, f: 1, e: 0 })
    expect(group.headline.unnecessarySearchRate).toMatchObject({ count: 0, total: 0, rate: null })
    expect(group.scoredTurnNotReached).toBe(1)
    const searchScenario = { ...scenario, criteria: { mustProduceOutput: true, minToolCalls: 1 } }
    const searchGroup = aggregateEvalMetrics(fixtureManifest([searchScenario], 1), [
      { ...trial, scenario: searchScenario },
    ]).groups['opus/pi']
    expect(searchGroup.headline.missedSearchRate).toMatchObject({ count: 0, total: 0, rate: null })
  })

  test('I1: reached follow-up headlines use only its own stream', async () => {
    const turns: number[] = []
    const adapter = adapterWithFetch(async () => {
      turns.push(1)
      const events =
        turns.length === 1
          ? [
              { type: 'tool-input-available', toolName: 'search', toolCallId: 'setup', input: { query: 'q' } },
              { type: 'tool-output-available', toolCallId: 'setup', output: 'evidence' },
              { type: 'text-delta', delta: 'setup answer' },
            ]
          : [{ type: 'text-delta', delta: 'reused answer' }]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''))
    })
    const scenario = { ...fixtureScenario('reached', 'multi_turn_reuse'), followUps: ['Reuse the answer'] }
    const attempt = await runScenario(scenario, adapter)
    expect(attempt.scoredTurnReached).toBe(true)
    expect(attempt.streams).toHaveLength(2)
    expect(attempt.result.toolCallCount).toBe(0)
    expect(attempt.result.responseText).toBe('reused answer')
    const trial = { id: `${scenario.id}/0`, index: 0, scenario, attempts: [attempt] }
    const group = aggregateEvalMetrics(fixtureManifest([scenario], 1), [trial]).groups['opus/pi']
    expect(group.headline.unnecessarySearchRate).toMatchObject({ count: 0, total: 1, rate: 0 })
    expect(group.scoredTurnNotReached).toBe(0)
  })

  test('empty setup answer is behavioural failure and never retried as infrastructure', async () => {
    const adapter = adapterWithFetch(async () => new Response('data: {"type":"finish"}\n'))
    const scenario = { ...fixtureScenario(), followUps: ['reuse the answer'] }
    const trial = await runTrial(scenario, 0, () => runScenario(scenario, adapter))
    expect(trial.attempts).toHaveLength(1)
    expect(trial.attempts[0].status).toBe('completed')
    expect(trial.attempts[0].verdicts.setupTurn).toBe('fail')
  })

  test('observes a research skill load through the real Pi result envelope', async () => {
    const adapter = adapterWithFetch(
      async () =>
        new Response(
          [
            { type: 'tool-input-available', toolName: 'skill', toolCallId: 'load', input: { name: 'research' } },
            {
              type: 'tool-output-available',
              toolCallId: 'load',
              output: { content: [{ type: 'text', text: 'instructions' }], details: 'instructions' },
            },
            { type: 'tool-input-available', toolName: 'search', toolCallId: 'web', input: { query: 'q' } },
            {
              type: 'tool-output-available',
              toolCallId: 'web',
              output: { content: [], details: { status: 'budget_exhausted' } },
            },
            { type: 'text-delta', delta: 'answer' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n`)
            .join(''),
        ),
    )
    const attempt = await runScenario(fixtureScenario(), adapter)
    expect(attempt.instrumentation.researchSkill).toEqual({ attempted: true, loaded: true, beforeFirstWebResult: true })
    expect(attempt.toolEvents.budgetDenial).toBe(1)
  })

  test('records actual budget executions and cache hits separately from emitted calls', async () => {
    const adapter = adapterWithFetch(async (_init, context) => {
      const budget = context.webToolBudget!
      await budget.execute('search', { query: 'q' }, async () => ({ result: 'ok' }))
      await budget.execute('search', { query: 'q' }, async () => {
        throw new Error('should be cached')
      })
      return new Response('data: {"type":"text-delta","delta":"answer"}\n')
    })
    const attempt = await runScenario(fixtureScenario(), adapter)
    expect(attempt.instrumentation).toMatchObject({ emitted: 0, executed: 1, cacheHits: 1, initialCap: 2, finalCap: 2 })
    expect(attempt.status).toBe('completed')
  })
})

test('pool retains every sample and persists completed trials before a later crash', async () => {
  const scenario = fixtureScenario()
  const completed: string[] = []
  const calls: number[] = []
  const write = spyOn(process.stdout, 'write').mockImplementation(() => true)
  initLayout([scenario], 1, 3)
  try {
    await expect(
      runPool(
        [scenario],
        1,
        adapterWithFetch(async () => new Response()),
        () => 3,
        (trial) => {
          completed.push(trial.id)
        },
        async () => {
          expect(completed).toHaveLength(calls.length)
          calls.push(1)
          if (calls.length === 3) {
            throw new Error('harness crash')
          }
          return fixtureAttempt()
        },
      ),
    ).rejects.toThrow('harness crash')
    expect(completed).toEqual([`${scenario.id}/0`, `${scenario.id}/1`])
  } finally {
    teardownLayout()
    write.mockRestore()
  }
})
