/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { convertToModelMessages } from 'ai'
import type { ThunderboltUIMessage } from '@/types'
import { buildAssistantParts, parseStream } from './stream-parser'
import type { ToolCallInfo } from './types'

const sseResponse = (events: object[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))

describe('buildAssistantParts', () => {
  test('emits a dynamic-tool part per completed call, a step boundary, then the text', () => {
    const toolCalls: ToolCallInfo[] = [
      { toolCallId: 'a', toolName: 'search', input: { query: 'x' } },
      { toolCallId: 'b', toolName: 'fetch_content', input: { url: 'u' } },
    ]
    // Only call "a" produced an output.
    const parts = buildAssistantParts('hello', toolCalls, new Map([['a', [{ title: 'r' }]]]))
    expect(parts).toEqual([
      {
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'a',
        state: 'output-available',
        input: { query: 'x' },
        output: [{ title: 'r' }],
      },
      { type: 'step-start' },
      { type: 'text', text: 'hello' },
    ])
  })

  test('omits the step boundary when there are no tool parts', () => {
    expect(buildAssistantParts('just text', [], new Map())).toEqual([{ type: 'text', text: 'just text' }])
  })

  test('omits the text part when text is blank', () => {
    expect(buildAssistantParts('   ', [], new Map())).toEqual([])
  })

  test('replays production order: assistant(tool) → tool(result) → assistant(text)', async () => {
    const parts = buildAssistantParts(
      'answer',
      [{ toolCallId: 'a', toolName: 'search', input: { query: 'x' } }],
      new Map([['a', [{ title: 'r' }]]]),
    )
    const messages: ThunderboltUIMessage[] = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm', role: 'assistant', parts },
    ]
    const model = await convertToModelMessages(messages)
    const roles = model.map((m) => m.role)
    const toolIdx = roles.indexOf('tool')
    expect(toolIdx).toBeGreaterThan(-1)
    // The final answer must be a SEPARATE assistant message AFTER the tool
    // result — never folded into the tool-call assistant message ahead of it.
    const trailing = model[toolIdx + 1]
    expect(trailing?.role).toBe('assistant')
    expect(JSON.stringify(trailing?.content)).toContain('answer')
  })
})

describe('parseStream', () => {
  test('captures tool input and reconstructs assistant parts with outputs', async () => {
    const response = sseResponse([
      { type: 'tool-input-available', toolCallId: 'a', toolName: 'search', input: { query: 'bitcoin' } },
      { type: 'tool-output-available', toolCallId: 'a', output: [{ title: 'BTC' }] },
      { type: 'text-delta', delta: 'Bitcoin is ' },
      { type: 'text-delta', delta: 'up.' },
      { type: 'finish-step', finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ])
    const parsed = await parseStream(response)
    expect(parsed.toolCalls).toEqual([{ toolCallId: 'a', toolName: 'search', input: { query: 'bitcoin' } }])
    expect(parsed.text).toBe('Bitcoin is up.')
    expect(parsed.assistantParts).toEqual([
      {
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'a',
        state: 'output-available',
        input: { query: 'bitcoin' },
        output: [{ title: 'BTC' }],
      },
      { type: 'step-start' },
      { type: 'text', text: 'Bitcoin is up.' },
    ])
  })

  test('drops tool calls that never produced an output from reconstructed parts', async () => {
    const response = sseResponse([
      { type: 'tool-input-available', toolCallId: 'a', toolName: 'search', input: { query: 'x' } },
      { type: 'text-delta', delta: 'done' },
      { type: 'finish', finishReason: 'stop' },
    ])
    const parsed = await parseStream(response)
    expect(parsed.toolCalls).toHaveLength(1)
    expect(parsed.assistantParts).toEqual([{ type: 'text', text: 'done' }])
  })
})
