/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { webToolNames } from '@/lib/tools'
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

const call = (toolName: string, input: unknown, toolCallId = crypto.randomUUID()): ToolCallInfo => ({
  toolCallId,
  toolName,
  input,
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
