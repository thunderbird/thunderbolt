/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { webToolNames } from '@/lib/tools'
import { fixtureScenario } from './test-fixtures'
import { countDuplicateToolCalls, scoreResult } from './scoring'
import type { EvalScenario, ParsedStream, ToolCallInfo } from './types'

const makeParsed = (overrides: Partial<ParsedStream> = {}): ParsedStream => ({
  text: 'answer [1]',
  toolCalls: [],
  assistantParts: [],
  stepCount: 1,
  retryCount: 0,
  finishReason: 'stop',
  ...overrides,
})

const call = (toolName: string, input: unknown, toolCallId: string = crypto.randomUUID()): ToolCallInfo => ({
  toolCallId,
  toolName,
  input,
})

describe('app tool criteria', () => {
  test('scores app tool decisions separately from web calls', () => {
    const scenario = {
      ...fixtureScenario(),
      criteria: {
        mustProduceOutput: true,
        maxToolCalls: 0,
        toolCallLimits: { save_memory: { min: 1, max: 1 }, search_sessions: { max: 0 } },
      },
    }
    expect(
      scoreResult(scenario, makeParsed({ toolCalls: [call('save_memory', { content: 'Prefers Celsius.' })] }), 0)
        .passed,
    ).toBe(true)
    expect(scoreResult(scenario, makeParsed(), 0).failures).toContain('Too few save_memory calls: 0 (min: 1)')
    expect(
      scoreResult(scenario, makeParsed({ toolCalls: [call('search_sessions', { query: 'unnecessary' })] }), 0).failures,
    ).toContain('Too many search_sessions calls: 1 (max: 0)')
  })

  test('measures UTF-8 outputs and unwraps Pi results before applying per-call and total limits', () => {
    const scenario = {
      ...fixtureScenario(),
      criteria: {
        mustProduceOutput: true,
        toolOutputLimits: { names: ['read_session'], perCallBytes: 5, totalBytes: 6 },
      },
    }
    const parsed = makeParsed({
      toolCalls: [call('read_session', {}, 'one'), call('read_session', {}, 'two')],
      events: [
        { type: 'tool-output-available', toolCallId: 'one', output: { details: '語語' } },
        { type: 'tool-output-available', toolCallId: 'two', output: 'ok' },
        { type: 'tool-output-available', toolCallId: 'unrelated', output: 'x'.repeat(1000) },
      ],
    })
    expect(scoreResult(scenario, parsed, 0).failures).toEqual([
      'App tool output exceeded 5 bytes',
      'App tool outputs exceeded 6 bytes in this turn',
    ])
  })

  test('checks retrieval facts and excluded canaries without case sensitivity', () => {
    const scenario = {
      ...fixtureScenario(),
      criteria: { mustProduceOutput: true, responseIncludes: ['quartz-4729'], responseExcludes: ['deleted-canary'] },
    }
    expect(scoreResult(scenario, makeParsed({ text: 'QUARTZ-4729' }), 0).passed).toBe(true)
    expect(scoreResult(scenario, makeParsed({ text: 'DELETED-CANARY' }), 0).failures).toHaveLength(2)
  })
})

describe('countDuplicateToolCalls', () => {
  test('counts a repeated (toolName, input) call', () => {
    expect(
      countDuplicateToolCalls([call('search', { q: 'x' }), call('search', { q: 'x' }), call('search', { q: 'y' })]),
    ).toBe(1)
  })

  test('is invariant to input key order', () => {
    expect(countDuplicateToolCalls([call('search', { a: 1, b: 2 }), call('search', { b: 2, a: 1 })])).toBe(1)
  })

  test('same input on different tools is not a duplicate', () => {
    expect(countDuplicateToolCalls([call('search', { q: 'x' }), call('fetch_content', { q: 'x' })])).toBe(0)
  })
})

describe('scoreResult — maxToolCalls + duplicate reporting', () => {
  const scenario: EvalScenario = {
    id: 'opus/pi/chat/MTx',
    modelName: 'opus',
    engineName: 'pi',
    modeName: 'chat',
    prompt: 'p',
    criteria: { mustProduceOutput: true, maxToolCalls: 0 },
  }

  test('fails when tool calls exceed the cap', () => {
    const result = scoreResult(scenario, makeParsed({ toolCalls: [call('search', { q: 'x' })] }), 100)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('Too many web tool calls'))).toBe(true)
  })

  test('passes when within the cap and reports the duplicate count', () => {
    const result = scoreResult(scenario, makeParsed({ toolCalls: [] }), 100)
    expect(result.passed).toBe(true)
    expect(result.duplicateToolCallCount).toBe(0)
  })

  test('surfaces duplicate tool calls in the result', () => {
    const dupScenario: EvalScenario = { ...scenario, criteria: { mustProduceOutput: true } }
    const result = scoreResult(
      dupScenario,
      makeParsed({ toolCalls: [call('search', { q: 'x' }), call('search', { q: 'x' })] }),
      100,
    )
    expect(result.duplicateToolCallCount).toBe(1)
    expect(result.toolCallCount).toBe(2)
  })

  test('excludes Pi coding tools from web-call limits and counts', () => {
    const result = scoreResult(
      scenario,
      makeParsed({
        toolCalls: [
          call('bash', { command: 'pwd' }),
          call('read', { path: '/tmp/a' }),
          call('write', { path: '/tmp/a' }),
          call('edit', { path: '/tmp/a' }),
        ],
      }),
      100,
    )

    expect(result.passed).toBe(true)
    expect(result.toolCallCount).toBe(0)
  })

  test('counts every production-budgeted web tool', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true } },
      makeParsed({ toolCalls: [...webToolNames].map((toolName) => call(toolName, {})) }),
      100,
    )

    expect(result.toolCallCount).toBe(webToolNames.size)
  })

  test('enforces minimum web calls', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, minToolCalls: 1 } },
      makeParsed({ toolCalls: [call('bash', { command: 'pwd' })] }),
      100,
    )

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Too few web tool calls: 0 (min: 1)')
  })

  test('fails when duplicate web calls are forbidden', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, noDuplicateToolCalls: true } },
      makeParsed({ toolCalls: [call('search', { query: 'x' }), call('search', { query: 'x' })] }),
      100,
    )

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Duplicate web tool calls: 1')
  })

  test('ignores duplicate coding calls when web duplicates are forbidden', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, noDuplicateToolCalls: true } },
      makeParsed({ toolCalls: [call('read', { path: '/tmp/a' }), call('read', { path: '/tmp/a' })] }),
      100,
    )

    expect(result.passed).toBe(true)
    expect(result.duplicateToolCallCount).toBe(0)
  })
})

describe('scoreResult — widget criteria', () => {
  const scenario: EvalScenario = {
    id: 'opus/pi/chat/WIDGET_TEST',
    modelName: 'opus',
    engineName: 'pi',
    modeName: 'chat',
    prompt: 'p',
    criteria: { mustProduceOutput: true },
  }

  test('requires the configured widget instead of accepting another widget', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, mustUseWidget: 'map' } },
      makeParsed({ text: '<widget:weather-forecast location="Berlin" region="" country="Germany" />' }),
      100,
    )

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('No <widget:map> tag found in response')
  })

  test('passes when the configured widget is present', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, mustUseWidget: 'ask' } },
      makeParsed({ text: `<widget:ask mode="choice" prompt="Pick one" options='[]' />` }),
      100,
    )

    expect(result.passed).toBe(true)
  })

  test('rejects every widget when widgets are forbidden', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, mustNotUseWidgets: true } },
      makeParsed({ text: 'Plain answer <widget:unknown />' }),
      100,
    )

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Unexpected widget tags found: unknown')
  })

  test('allows plain text when widgets are forbidden', () => {
    const result = scoreResult(
      { ...scenario, criteria: { mustProduceOutput: true, mustNotUseWidgets: true } },
      makeParsed({ text: 'Plain answer' }),
      100,
    )

    expect(result.passed).toBe(true)
  })
})

test.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
  [false, false, true],
] as const)('research skill criterion expected=%s observed=%s passes=%s', (expected, loaded, passed) => {
  const scenario = { ...fixtureScenario(), criteria: { mustProduceOutput: true, expectResearchSkill: expected } }
  expect(scoreResult(scenario, makeParsed({ researchSkillLoaded: loaded }), 0).passed).toBe(passed)
})
