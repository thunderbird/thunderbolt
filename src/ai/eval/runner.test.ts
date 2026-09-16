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
import { buildJudgePrompt, type JudgeVerdict } from './judge'
import { acceptEval, aggregateEvalMetrics } from './stats'
import { fixtureAttempt, fixtureManifest, fixtureScenario } from './test-fixtures'
import {
  createEvalAdapterContext,
  extractTurnEvidence,
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

  test('a failed declared setup assertion stops before the final turn and retains the verdict', async () => {
    const calls: number[] = []
    const adapter = adapterWithFetch(async () => {
      calls.push(1)
      return new Response('data: {"type":"text-delta","delta":"knowledge then offer, no caveat"}\n')
    })
    const scenario = {
      ...fixtureScenario(),
      promptCriteria: { mustProduceOutput: true, expectSearchOffer: true },
      followUps: ['verify'],
    }
    const attempt = await runScenario(scenario, adapter, fetchAndParseTurn, async () => ({
      correct: null,
      searchOffer: true,
      freshnessCaveat: false,
      evidenceCoverage: null,
      reuseFidelity: null,
      premiseRebuttal: null,
      verificationDisclaimer: null,
      replyLanguageMatches: null,
      explanation: 'Missing caveat',
    }))
    expect(calls).toHaveLength(1)
    expect(attempt.status).toBe('completed')
    expect(attempt.scoredTurnReached).toBe(false)
    expect(attempt.verdicts['turn1.expectSearchOffer']).toBe('fail')
    expect(attempt.turnResults?.[0].result.judgeVerdict?.freshnessCaveat).toBe(false)
    const metrics = aggregateEvalMetrics(fixtureManifest([scenario], 1), [
      { scenario, index: 0, id: `${scenario.id}/0`, attempts: [attempt] },
    ])
    expect(metrics.groups['opus/pi'].scenarios[scenario.id]).toMatchObject({ f: 1, e: 0 })
  })

  test('I1: a recovered final-turn judge error counts once after successful setup judging', async () => {
    const scenario = {
      ...fixtureScenario(),
      promptCriteria: { mustProduceOutput: true, expectCorrectAnswer: true },
      followUps: ['final answer'],
      criteria: { mustProduceOutput: true, expectCorrectAnswer: true },
    }
    const adapter = adapterWithFetch(async () => new Response('data: {"type":"text-delta","delta":"answer"}\n'))
    const finalCalls: number[] = []
    const trial = await runTrial(scenario, 0, () =>
      runScenario(scenario, adapter, fetchAndParseTurn, async (_turn, conversation) => {
        if (conversation.length === 2) {
          finalCalls.push(1)
          if (finalCalls.length === 1) {
            throw new Error('transient final judge failure')
          }
        }
        return {
          correct: true,
          searchOffer: null,
          freshnessCaveat: null,
          evidenceCoverage: null,
          reuseFidelity: null,
          premiseRebuttal: null,
          verificationDisclaimer: null,
          replyLanguageMatches: null,
          explanation: 'accepted',
        }
      }),
    )
    expect(
      trial.attempts[0].turnResults?.map(({ result }) => result.judgeAttempts?.map(({ status }) => status)),
    ).toEqual([['completed'], ['judge_error', 'completed']])
    const metrics = aggregateEvalMetrics(fixtureManifest([scenario], 1), [trial])
    expect(metrics.groups['opus/pi'].reliability).toMatchObject({
      errors: 0,
      firstAttemptJudgeErrors: 1,
      firstAttemptErrors: 1,
      firstAttemptErrorRate: 1,
    })
    expect(trial.attempts[0].result.passed).toBe(true)
    expect(metrics.groups['opus/pi'].scenarios[scenario.id]).toMatchObject({ c: 1, f: 0, e: 0 })
    expect(acceptEval(metrics).exitCode).toBe(0)
    trial.attempts[0].turnResults![0].result.judgeAttempts!.unshift({
      status: 'judge_error',
      durationMs: 1,
      error: 'also recovered',
    })
    expect(
      aggregateEvalMetrics(fixtureManifest([scenario], 1), [trial]).groups['opus/pi'].reliability
        .firstAttemptJudgeErrors,
    ).toBe(1)
  })

  test('setup judge errors retain the two-attempt rule and do not become generation retries', async () => {
    const generations: number[] = []
    const grades: number[] = []
    const scenario = {
      ...fixtureScenario(),
      promptCriteria: { mustProduceOutput: true, expectCorrectAnswer: true },
      followUps: ['continue'],
    }
    const adapter = adapterWithFetch(async () => {
      generations.push(1)
      return new Response('data: {"type":"text-delta","delta":"answer"}\n')
    })
    const trial = await runTrial(scenario, 0, () =>
      runScenario(scenario, adapter, fetchAndParseTurn, async () => {
        grades.push(1)
        throw new Error('judge unavailable')
      }),
    )
    expect(generations).toHaveLength(1)
    expect(grades).toHaveLength(2)
    expect(trial.attempts[0].status).toBe('judge_error')
    expect(trial.attempts[0].scoredTurnReached).toBe(false)
    expect(trial.attempts[0].turnResults?.[0].result.judgeAttempts).toHaveLength(2)
    expect(aggregateEvalMetrics(fixtureManifest([scenario], 1), [trial]).groups['opus/pi'].reliability).toMatchObject({
      errors: 1,
      firstAttemptJudgeErrors: 1,
    })
  })

  test('judges each declared turn with its own expectations and labelled conversation', async () => {
    const scenario = {
      ...fixtureScenario(),
      promptCriteria: { mustProduceOutput: true, expectCorrectAnswer: true },
      promptExpectation: { expectCorrectAnswer: 'FIRST EXPECTATION' },
      followUps: [
        {
          prompt: 'verify',
          criteria: { mustProduceOutput: true, expectEvidenceCoverage: true },
          expectation: { expectEvidenceCoverage: 'SECOND EXPECTATION' },
        },
        { prompt: 'repeat the earlier answer' },
      ],
      criteria: { mustProduceOutput: true, expectReuseFidelity: true },
      expectation: { expectReuseFidelity: 'FINAL EXPECTATION' },
    }
    const prompts: string[] = []
    const adapter = adapterWithFetch(
      async () =>
        new Response(
          [
            { type: 'tool-input-available', toolName: 'search', toolCallId: 'source', input: { query: 'q' } },
            {
              type: 'tool-output-available',
              toolCallId: 'source',
              output: {
                details: [
                  { sourceIndex: 1, pageUrl: 'https://source.test', title: 'Snippet', snippet: 'EVIDENCE-BODY' },
                ],
              },
            },
            { type: 'text-delta', delta: 'answer [1]' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n`)
            .join(''),
        ),
    )
    const attempt = await runScenario(scenario, adapter, fetchAndParseTurn, async (turn, conversation) => {
      prompts.push(buildJudgePrompt(turn, conversation.at(-1)!.responseText, conversation))
      const verdict: JudgeVerdict = {
        correct: null,
        searchOffer: null,
        freshnessCaveat: null,
        evidenceCoverage: null,
        reuseFidelity: null,
        premiseRebuttal: null,
        verificationDisclaimer: null,
        replyLanguageMatches: null,
        explanation: 'accepted',
      }
      return {
        ...verdict,
        correct: turn.criteria.expectCorrectAnswer ? true : null,
        evidenceCoverage: turn.criteria.expectEvidenceCoverage ? true : null,
        reuseFidelity: turn.criteria.expectReuseFidelity ? true : null,
      }
    })
    expect(attempt.result.passed).toBe(true)
    expect(attempt.turnResults).toHaveLength(3)
    expect(prompts[0]).toContain('FIRST EXPECTATION')
    expect(prompts[0]).not.toContain('EVIDENCE-BODY')
    expect(prompts[1]).toContain('SECOND EXPECTATION')
    expect(prompts[1]).toContain('Turn 1 Source [1]')
    expect(prompts[1]).toContain('Turn 2 Source [1]')
    expect(prompts[2]).toContain('FINAL EXPECTATION')
    expect(prompts[2]).toContain('Turn 3 (scored)')
    expect(prompts[2]).not.toContain('EVIDENCE-BODY')
    expect(attempt.verdicts.expectReuseFidelity).toBe('pass')
  })

  test.each([{ name: 42 }, { name: {} }, { name: [] }])(
    'I1: records a recovered malformed skill input %j without counting a load',
    async (input) => {
      const events: Record<string, unknown>[] = [
        { type: 'tool-input-available', toolName: 'skill', toolCallId: 'bad', input },
        { type: 'tool-output-error', toolCallId: 'bad', errorText: 'Invalid arguments: name must be a string' },
      ]
      const adapter = adapterWithFetch(
        async () =>
          new Response(
            [...events, { type: 'text-delta', delta: 'Recovered answer' }]
              .map((event) => `data: ${JSON.stringify(event)}\n`)
              .join(''),
          ),
      )
      const scenario = { ...fixtureScenario(), criteria: { mustProduceOutput: true, expectResearchSkill: false } }
      const trial = await runTrial(scenario, 0, () => runScenario(scenario, adapter))
      expect(trial.attempts).toHaveLength(1)
      const attempt = trial.attempts[0]
      expect(attempt.status).toBe('completed')
      expect(attempt.result.passed).toBe(true)
      expect(attempt.result.responseText).toBe('Recovered answer')
      expect(attempt.streams[0].researchSkillLoaded).toBe(false)
      expect(attempt.instrumentation.researchSkill.loaded).toBe(false)
      expect(attempt.verdicts.expectResearchSkill).toBe('pass')
      expect(attempt.toolEvents.toolMisuse).toBe(1)
      expect(attempt.streams[0].events?.slice(0, 2)).toEqual(events)

      events.push(
        { type: 'tool-input-available', toolName: 'skill', toolCallId: 'good', input: { name: ' /research ' } },
        { type: 'tool-output-available', toolCallId: 'good', output: { details: 'Research instructions' } },
      )
      const required = { ...scenario, criteria: { mustProduceOutput: true, expectResearchSkill: true } }
      const recovered = await runTrial(required, 1, () => runScenario(required, adapter))
      expect(recovered.attempts[0].result.passed).toBe(true)
      expect(recovered.attempts[0].streams[0].researchSkillLoaded).toBe(true)
      expect(recovered.attempts[0].instrumentation.researchSkill.loaded).toBe(true)
      expect(recovered.attempts[0].toolEvents.toolMisuse).toBe(1)
    },
  )

  test('research-skill criteria use successful loads in the scored turn only', async () => {
    const turns: number[] = []
    const adapter = adapterWithFetch(async () => {
      turns.push(1)
      const events =
        turns.length === 1
          ? [
              { type: 'tool-input-available', toolName: 'skill', toolCallId: 'load', input: { name: ' /research ' } },
              { type: 'tool-output-available', toolCallId: 'load', output: { details: 'research instructions' } },
            ]
          : []
      return new Response(
        [...events, { type: 'text-delta', delta: 'answer' }]
          .map((event) => `data: ${JSON.stringify(event)}\n`)
          .join(''),
      )
    })
    const scenario = {
      ...fixtureScenario(),
      promptCriteria: { mustProduceOutput: true, expectResearchSkill: true },
      followUps: ['Answer from the prior result'],
      criteria: { mustProduceOutput: true, expectResearchSkill: false },
    }
    const attempt = await runScenario(scenario, adapter)
    expect(attempt.result.passed).toBe(true)
    expect(attempt.streams.map(({ researchSkillLoaded }) => researchSkillLoaded)).toEqual([true, false])
    expect(attempt.instrumentation.researchSkill.loaded).toBe(true)
    expect(attempt.verdicts.expectResearchSkill).toBe('pass')
  })

  test.each(['tool-output-error', 'unrelated', 'empty'] as const)(
    'research-skill criterion rejects %s loads',
    async (kind) => {
      const events = [
        {
          type: 'tool-input-available',
          toolName: 'skill',
          toolCallId: 'load',
          input: { name: kind === 'unrelated' ? 'weather' : 'research' },
        },
        {
          type: kind === 'tool-output-error' ? kind : 'tool-output-available',
          toolCallId: 'load',
          errorText: 'load failed',
          output: { details: kind === 'empty' ? '   ' : 'instructions' },
        },
        { type: 'text-delta', delta: 'answer' },
      ]
      const adapter = adapterWithFetch(
        async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')),
      )
      const attempt = await runScenario(
        { ...fixtureScenario(), criteria: { mustProduceOutput: true, expectResearchSkill: true } },
        adapter,
      )
      expect(attempt.result.passed).toBe(false)
      expect(attempt.verdicts.expectResearchSkill).toBe('fail')
    },
  )

  test('a forbidden successful research load before transport failure blocks generation retry', async () => {
    const events = [
      { type: 'tool-input-available', toolName: 'skill', toolCallId: 'load', input: { name: 'research' } },
      { type: 'tool-output-available', toolCallId: 'load', output: { details: 'research instructions' } },
      { type: 'error', errorText: 'transport failed' },
    ]
    const adapter = adapterWithFetch(
      async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')),
    )
    const scenario = { ...fixtureScenario(), criteria: { mustProduceOutput: true, expectResearchSkill: false } }
    const trial = await runTrial(scenario, 0, () => runScenario(scenario, adapter))
    expect(trial.attempts).toHaveLength(1)
    expect(trial.attempts[0].status).toBe('infra_error')
    expect(trial.attempts[0].verdicts.expectResearchSkill).toBe('fail')
    expect(trial.attempts[0].provenFailure).toBe(true)
    const required = { ...scenario, criteria: { mustProduceOutput: true, expectResearchSkill: true } }
    expect(deterministicVerdicts(required, fixtureAttempt().streams[0], false).expectResearchSkill).toBe('unknown')
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

  test('records the promoted live cap from the scored turn budget', async () => {
    const adapter = adapterWithFetch(async (_init, context) => {
      context.webToolBudget!.promoteToResearch()
      return new Response('data: {"type":"text-delta","delta":"answer"}\n')
    })
    const attempt = await runScenario(fixtureScenario(), adapter)
    expect(attempt.instrumentation).toMatchObject({ initialCap: 2, finalCap: 30, promoted: true })
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

test('extracts only registered web evidence from Pi or legacy outputs without renumbering', () => {
  const parsed = fixtureAttempt().streams[0]
  parsed.toolCalls = [
    { toolName: 'search', toolCallId: 'search' },
    { toolName: 'fetch_content', toolCallId: 'fetch' },
    { toolName: 'bash', toolCallId: 'bash' },
  ]
  parsed.events = [
    {
      type: 'tool-output-available',
      toolCallId: 'search',
      output: { details: [{ sourceIndex: 7, pageUrl: 'https://a.test', title: 'A', text: '   ', snippet: 'snippet' }] },
    },
    {
      type: 'tool-output-available',
      toolCallId: 'fetch',
      output: { sourceIndex: 7, url: 'https://a.test', text: 'full page' },
    },
    {
      type: 'tool-output-available',
      toolCallId: 'bash',
      output: { sourceIndex: 8, url: 'https://b.test', text: 'not web evidence' },
    },
    { type: 'tool-output-available', toolCallId: 'fetch', output: null },
  ]
  const evidence = extractTurnEvidence(parsed)
  expect(evidence.map(({ sourceIndex }) => sourceIndex)).toEqual([7, 7])
  expect(evidence.map(({ text }) => text)).toEqual(['snippet', 'full page'])
})
