/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AgentHarness, AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { readUIMessageStream, type UIMessage } from 'ai'
import { piHarnessToUiMessageStream, type AiSdkChunk } from './pi-to-aisdk-stream.ts'

type ContentEvent =
  | { type: 'text_start' | 'thinking_start'; contentIndex: number }
  | { type: 'text_delta' | 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string }

const assistantMessage: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider: 'fixture',
  model: 'fixture',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
}

/** Supplies typed harness events without starting a model or mocking shared modules. */
const createHarnessEvents = () => {
  const listeners = new Set<(event: AgentHarnessEvent) => void>()
  const harness: Pick<AgentHarness, 'subscribe' | 'abort'> = {
    subscribe: (listener: (event: AgentHarnessEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
  }
  const emit = (event: AgentHarnessEvent): void => listeners.forEach((listener) => listener(event))
  return { harness, emit }
}

/** Parses the translator's JSON SSE chunks, excluding the terminal DONE marker. */
const parseChunks = (output: string): AiSdkChunk[] =>
  output
    .split('\n\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line): AiSdkChunk => JSON.parse(line.slice(6)))

/** Replays compact Pi updates through the translator and the app's UI stream consumer. */
const translate = async (...messages: ContentEvent[][]) => {
  const { harness, emit } = createHarnessEvents()
  const output = await new Response(
    piHarnessToUiMessageStream(harness, async () => {
      emit({ type: 'agent_start' })
      for (const updates of messages) {
        emit({ type: 'turn_start' })
        for (const update of updates) {
          emit({
            type: 'message_update',
            message: assistantMessage,
            assistantMessageEvent: { ...update, partial: assistantMessage },
          })
        }
        emit({ type: 'message_end', message: assistantMessage })
        emit({ type: 'turn_end', message: assistantMessage, toolResults: [] })
      }
      emit({ type: 'agent_end', messages: [] })
    }),
  ).text()
  const chunks = parseChunks(output)
  const snapshots: UIMessage[] = []
  for await (const message of readUIMessageStream({
    stream: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    }),
    terminateOnError: true,
  })) {
    snapshots.push(message)
  }
  return { chunks, parts: snapshots.at(-1)?.parts.filter((part) => part.type !== 'step-start') }
}

describe('piHarnessToUiMessageStream content boundaries', () => {
  it.each([' tail', ' ', '\n'])('keeps the answer intact across a mixed reasoning tail %j', async (tail) => {
    const { chunks, parts } = await translate([
      { type: 'thinking_delta', contentIndex: 0, delta: 'Plan' },
      { type: 'text_start', contentIndex: 1 },
      { type: 'text_delta', contentIndex: 1, delta: 'I' },
      { type: 'thinking_delta', contentIndex: 0, delta: tail },
      { type: 'text_delta', contentIndex: 1, delta: "'ll research…" },
      { type: 'text_delta', contentIndex: 1, delta: ' Done.' },
    ])

    expect(chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(1)
    expect(parts).toMatchObject([
      { type: 'reasoning', text: `Plan${tail}`, state: 'done' },
      { type: 'text', text: "I'll research… Done.", state: 'done' },
    ])
    const reasoningEnd = chunks.findIndex((chunk) => chunk.type === 'reasoning-end')
    expect(reasoningEnd).toBeGreaterThan(chunks.findLastIndex((chunk) => chunk.type === 'reasoning-delta'))
    expect(reasoningEnd).toBeLessThan(
      chunks.findIndex((chunk) => chunk.type === 'text-delta' && chunk.delta === "'ll research…"),
    )
  })

  it.each([false, true])('keeps a new thinking block separate (explicit text end: %j)', async (explicitEnd) => {
    const end: ContentEvent[] = explicitEnd ? [{ type: 'text_end', contentIndex: 1, content: 'First answer.' }] : []
    const { chunks, parts } = await translate([
      { type: 'thinking_delta', contentIndex: 0, delta: 'First thought.' },
      { type: 'text_delta', contentIndex: 1, delta: 'First answer.' },
      ...end,
      { type: 'thinking_delta', contentIndex: 2, delta: 'Another thought.' },
      { type: 'text_delta', contentIndex: 3, delta: 'Second answer.' },
    ])
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(2)
    expect(parts).toMatchObject([
      { type: 'reasoning', text: 'First thought.', state: 'done' },
      { type: 'text', text: 'First answer.', state: 'done' },
      { type: 'reasoning', text: 'Another thought.', state: 'done' },
      { type: 'text', text: 'Second answer.', state: 'done' },
    ])
  })

  it('respects separate adjacent content blocks and resets indices between messages', async () => {
    const updates: ContentEvent[] = [
      { type: 'thinking_delta', contentIndex: 0, delta: 'Think.' },
      { type: 'thinking_end', contentIndex: 0, content: 'Think.' },
      { type: 'thinking_delta', contentIndex: 1, delta: 'Again.' },
      { type: 'text_delta', contentIndex: 2, delta: 'First.' },
      { type: 'text_delta', contentIndex: 3, delta: 'Second.' },
    ]
    const { chunks, parts } = await translate(updates, updates)
    expect(chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(4)
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(4)
    expect(parts?.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'First.',
      'Second.',
      'First.',
      'Second.',
    ])
    expect(new Set(chunks.filter((chunk) => chunk.type === 'reasoning-start').map((chunk) => chunk.id)).size).toBe(4)
  })

  const capturedTransitions: { name: string; events: ContentEvent[]; text: string; reasoning: string }[] = [
    {
      name: 'medium-2',
      events: [
        { type: 'thinking_delta', contentIndex: 0, delta: ' Output Generation:** (Drafting' },
        { type: 'text_start', contentIndex: 1 },
        { type: 'text_delta', contentIndex: 1, delta: '**Sub' },
        { type: 'thinking_delta', contentIndex: 0, delta: ' the response)' },
        { type: 'text_delta', contentIndex: 1, delta: '-questions' },
        { type: 'text_delta', contentIndex: 1, delta: ' to' },
      ],
      text: '**Sub-questions to',
      reasoning: ' Output Generation:** (Drafting the response)',
    },
    {
      name: 'medium-3',
      events: [
        { type: 'thinking_delta', contentIndex: 0, delta: ' this research topic' },
        { type: 'text_start', contentIndex: 1 },
        { type: 'text_delta', contentIndex: 1, delta: '## Five Sub-Questions for Research' },
        { type: 'thinking_delta', contentIndex: 0, delta: '.' },
        { type: 'text_delta', contentIndex: 1, delta: 'ing the Best Third-Party' },
        { type: 'text_delta', contentIndex: 1, delta: ' PS5 Controllers in 202' },
      ],
      text: '## Five Sub-Questions for Researching the Best Third-Party PS5 Controllers in 202',
      reasoning: ' this research topic.',
    },
    {
      name: 'off-2',
      events: [
        { type: 'thinking_delta', contentIndex: 0, delta: ' a suggested' },
        { type: 'text_start', contentIndex: 1 },
        { type: 'text_delta', contentIndex: 1, delta: '#' },
        { type: 'thinking_delta', contentIndex: 0, delta: ' starting point.' },
        { type: 'text_delta', contentIndex: 1, delta: ' Research' },
        { type: 'text_delta', contentIndex: 1, delta: 'ing Third' },
      ],
      text: '# Researching Third',
      reasoning: ' a suggested starting point.',
    },
  ]

  it.each(capturedTransitions)('preserves the captured $name transition', async ({ events, text, reasoning }) => {
    const { chunks, parts } = await translate(events)
    expect(chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(1)
    expect(parts).toMatchObject([
      { type: 'reasoning', text: reasoning, state: 'done' },
      { type: 'text', text, state: 'done' },
    ])
  })
})

describe('piHarnessToUiMessageStream metadata', () => {
  it.each([
    { tail: false, duration: 100 },
    { tail: true, duration: 110 },
  ])('excludes the wait for more answer text from reasoning duration (tail: $tail)', async ({ tail, duration }) => {
    const { harness, emit } = createHarnessEvents()
    const clock = { time: 100 }
    const tailUpdates: (ContentEvent & { at: number })[] = tail
      ? [{ at: 210, type: 'thinking_delta', contentIndex: 0, delta: ' tail' }]
      : []
    const updates: (ContentEvent & { at: number })[] = [
      { at: 100, type: 'thinking_delta', contentIndex: 0, delta: 'Plan' },
      { at: 200, type: 'text_delta', contentIndex: 1, delta: 'I' },
      ...tailUpdates,
      { at: 5000, type: 'text_delta', contentIndex: 1, delta: "'ll research…" },
    ]
    const output = await new Response(
      piHarnessToUiMessageStream(
        harness,
        async () => {
          emit({ type: 'agent_start' })
          for (const { at, ...update } of updates) {
            clock.time = at
            emit({
              type: 'message_update',
              message: assistantMessage,
              assistantMessageEvent: { ...update, partial: assistantMessage },
            })
          }
          emit({ type: 'agent_end', messages: [] })
        },
        {},
        () => clock.time,
      ),
    ).text()
    const chunks = parseChunks(output)
    expect(chunks.filter((chunk) => chunk.type === 'message-metadata')).toEqual([
      { type: 'message-metadata', messageMetadata: { reasoningTime: { 'reasoning-0': duration } } },
    ])
  })

  it('emits initial, invoked-tool, and settled metadata', async () => {
    const { harness, emit } = createHarnessEvents()
    const stream = piHarnessToUiMessageStream(
      harness,
      async () => {
        emit({ type: 'agent_start' })
        emit({ type: 'turn_start' })
        emit({
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'search_web',
          args: {},
        })
        emit({
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'search_web',
          result: { content: [{ type: 'text', text: 'done' }], details: {} },
          isError: false,
        })
        emit({ type: 'turn_end', message: assistantMessage, toolResults: [] })
        emit({ type: 'agent_end', messages: [] })
      },
      {
        initial: { modelId: 'model-1' },
        toolCall: (toolName) => ({ mcpTools: { [toolName]: { name: 'Search' } } }),
        settled: () => ({ sources: [{ id: 'source-1' }] }),
      },
    )

    const output = await new Response(stream).text()

    expect(output).toContain('"messageMetadata":{"modelId":"model-1"}')
    expect(output).toContain('"mcpTools":{"search_web":{"name":"Search"}}')
    expect(output).toContain('"sources":[{"id":"source-1"}]')
  })
})
