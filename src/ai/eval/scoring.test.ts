/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
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
    id: 'opus/chat/MTx',
    modelName: 'opus',
    modeName: 'chat',
    prompt: 'p',
    criteria: { mustProduceOutput: true, maxToolCalls: 0 },
  }

  test('fails when tool calls exceed the cap', () => {
    const result = scoreResult(scenario, makeParsed({ toolCalls: [call('search', { q: 'x' })] }), 100)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('Too many tool calls'))).toBe(true)
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
})
