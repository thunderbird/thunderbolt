/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentHarnessEvent,
  type AgentHarnessTool,
} from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseStep,
  type Message,
} from '@earendil-works/pi-ai'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { convertToModelMessages, generateText, readUIMessageStream, type UIMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { Type } from 'typebox'
import { piHarnessToUiMessageStream, type AiSdkChunk } from './pi-to-aisdk-stream.ts'
import { stoppedReplyMarker } from './stopped-reply.ts'

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
  const harness: Pick<AgentHarness, 'subscribe' | 'abort' | 'appendMessage'> = {
    subscribe: (listener: (event: AgentHarnessEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
    appendMessage: async () => {},
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

/** Deliver one Pi block update, including incomplete provider identity fields. */
const toolUpdate = (
  emit: (event: AgentHarnessEvent) => void,
  index: number,
  type: 'toolcall_start' | 'toolcall_delta',
  id: string,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const partial: AssistantMessage = {
    ...assistantMessage,
    content: Array.from({ length: index }, (): { type: 'text'; text: string } => ({ type: 'text', text: '' })),
  }
  partial.content.push({ type: 'toolCall', id, name, arguments: args })
  emit({
    type: 'message_update',
    message: partial,
    assistantMessageEvent:
      type === 'toolcall_delta'
        ? { type, contentIndex: index, partial, delta: '' }
        : { type, contentIndex: index, partial },
  })
}

describe('streaming tool inputs', () => {
  it('identifies interleaved calls with a late id or name and times only execution', async () => {
    const { harness, emit } = createHarnessEvents()
    let time = 0
    const first = 'call-a|item-a'
    const stream = piHarnessToUiMessageStream(
      harness,
      async () => {
        emit({ type: 'agent_start' })
        emit({ type: 'turn_start' })
        toolUpdate(emit, 0, 'toolcall_start', '', 'first')
        toolUpdate(emit, 1, 'toolcall_start', 'b', '')
        toolUpdate(emit, 1, 'toolcall_delta', 'b', 'second')
        toolUpdate(emit, 0, 'toolcall_delta', first, 'first')
        toolUpdate(emit, 1, 'toolcall_delta', 'b', 'second')
        emit({ type: 'message_end', message: assistantMessage })
        time = 100
        emit({ type: 'tool_execution_start', toolCallId: first, toolName: 'first', args: { a: 1 } })
        time = 120
        emit({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'second', args: { b: 2 } })
        time = 130
        for (const [id, name] of [
          ['b', 'second'],
          [first, 'first'],
        ] as const) {
          emit({
            type: 'tool_execution_end',
            toolCallId: id,
            toolName: name,
            isError: false,
            result: { content: [], details: {} },
          })
        }
      },
      { toolCall: (name) => ({ invoked: name }) },
      undefined,
      () => time,
    )
    const chunks = parseChunks(await new Response(stream).text())
    expect(chunks.filter((chunk) => 'toolCallId' in chunk)).toMatchObject([
      { type: 'tool-input-start', toolCallId: 'b', toolName: 'second' },
      { type: 'tool-input-start', toolCallId: first, toolName: 'first' },
      { type: 'tool-input-available', toolCallId: first, input: { a: 1 } },
      { type: 'tool-input-available', toolCallId: 'b', input: { b: 2 } },
      { type: 'tool-output-available', toolCallId: 'b' },
      { type: 'tool-output-available', toolCallId: first },
    ])
    expect(chunks.flatMap((chunk) => (chunk.type === 'message-metadata' ? [chunk.messageMetadata] : []))).toEqual([
      { invoked: 'first' },
      { invoked: 'second' },
      { reasoningTime: { b: 10 } },
      { reasoningTime: { [first]: 30 } },
    ])
  })

  it('settles both a header-only call and an executing sibling on Stop', async () => {
    const { harness, emit } = createHarnessEvents()
    const stop = new AbortController()
    const stream = piHarnessToUiMessageStream(
      harness,
      async () => {
        emit({ type: 'agent_start' })
        emit({ type: 'turn_start' })
        toolUpdate(emit, 0, 'toolcall_start', 'pending', 'second')
        emit({ type: 'tool_execution_start', toolName: 'first', toolCallId: 'running', args: { n: 1 } })
        stop.abort()
      },
      {},
      stop.signal,
    )
    const chunks = parseChunks(await new Response(stream).text())
    expect(chunks.filter((chunk) => 'toolCallId' in chunk)).toMatchObject([
      { type: 'tool-input-start', toolCallId: 'pending' },
      { type: 'tool-input-start', toolCallId: 'running' },
      { type: 'tool-input-available', toolCallId: 'running' },
      { type: 'tool-input-error', toolCallId: 'pending', input: {}, errorText: 'AbortError' },
      { type: 'tool-output-error', toolCallId: 'running' },
    ])
  })

  it.each(['Stop', 'provider error', 'run rejection'] as const)(
    'settles unfinished inputs on %s before replay',
    async (ending) => {
      const { harness, emit } = createHarnessEvents()
      const signal = new AbortController()
      const stream = piHarnessToUiMessageStream(
        harness,
        async () => {
          emit({ type: 'agent_start' })
          emit({ type: 'turn_start' })
          toolUpdate(emit, 0, 'toolcall_start', 'office', 'run_office_script')
          toolUpdate(emit, 0, 'toolcall_delta', 'office', 'run_office_script', { script: 'unfinished' })
          if (ending === 'Stop') {
            signal.abort()
          } else if (ending === 'run rejection') {
            throw new Error('connection lost')
          } else {
            const failed = { ...assistantMessage, stopReason: 'error' as const, errorMessage: 'connection lost' }
            emit({ type: 'message_end', message: failed })
            emit({ type: 'turn_end', message: failed, toolResults: [] })
          }
        },
        {},
        signal.signal,
      )
      const chunks = parseChunks(await new Response(stream).text())
      expect(chunks.filter((chunk) => 'toolCallId' in chunk)).toMatchObject([
        { type: 'tool-input-start', toolCallId: 'office' },
        {
          type: 'tool-input-error',
          toolCallId: 'office',
          input: { script: 'unfinished' },
          toolMetadata: { interrupted: true },
        },
      ])
      expect(chunks.map((chunk) => chunk.type).indexOf('tool-input-error')).toBeLessThan(
        chunks.findIndex((chunk) => ['error', 'finish-step', 'finish'].includes(chunk.type)),
      )
      const snapshots: UIMessage[] = []
      for await (const message of readUIMessageStream({
        stream: new ReadableStream({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk))
            controller.close()
          },
        }),
        onError: () => {},
      })) {
        snapshots.push(message)
      }
      expect(snapshots.flatMap((message) => message.parts)).toContainEqual(
        expect.objectContaining({ state: 'input-streaming', toolMetadata: { piInputHeader: true } }),
      )
      const stopped = snapshots.at(-1)!
      expect(stopped.parts.filter((part) => part.type !== 'step-start')).toMatchObject([{ state: 'output-error' }])

      const requests: unknown[] = []
      const model = createAnthropic({
        apiKey: 'fixture',
        fetch: Object.assign(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)))
            return Response.json({
              type: 'message',
              role: 'assistant',
              model: 'test',
              id: 'next',
              content: [{ type: 'text', text: 'OK' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          },
          { preconnect: () => {} },
        ),
      })('claude-sonnet-4-5')
      const messages = await convertToModelMessages([
        stopped,
        { id: 'next', role: 'user', parts: [{ type: 'text', text: 'Continue' }] },
      ])
      await generateText({ model, messages })
      expect(requests[0]).toMatchObject({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'office', input: { script: 'unfinished' } }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'office', is_error: true },
              { type: 'text', text: 'Continue' },
            ],
          },
        ],
      })
    },
  )
})

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
        undefined,
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

    expect(
      parseChunks(output)
        .filter((chunk) => 'toolCallId' in chunk)
        .map((chunk) => chunk.type),
    ).toEqual(['tool-input-start', 'tool-input-available', 'tool-output-available'])
    expect(output).toContain('"messageMetadata":{"modelId":"model-1"}')
    expect(output).toContain('"mcpTools":{"search_web":{"name":"Search"}}')
    expect(output).toContain('"sources":[{"id":"source-1"}]')
  })

  it('emits the turn usage as AI SDK usage so the thread context size is persisted', async () => {
    const { harness, emit } = createHarnessEvents()
    const message: AssistantMessage = {
      ...assistantMessage,
      usage: {
        input: 100,
        output: 40,
        cacheRead: 3_000,
        cacheWrite: 500,
        reasoning: 25,
        totalTokens: 3_640,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    const output = await new Response(
      piHarnessToUiMessageStream(harness, async () => {
        emit({ type: 'agent_start' })
        emit({ type: 'turn_start' })
        emit({ type: 'turn_end', message, toolResults: [] })
        emit({ type: 'agent_end', messages: [] })
      }),
    ).text()

    expect(parseChunks(output).filter((chunk) => chunk.type === 'message-metadata')).toEqual([
      {
        type: 'message-metadata',
        messageMetadata: {
          usage: {
            inputTokens: 3_600,
            outputTokens: 40,
            totalTokens: 3_640,
            cachedInputTokens: 3_000,
            reasoningTokens: 25,
          },
        },
      },
    ])
  })
})

/** Harness fake that records aborts and lets the test drive events by hand. */
const createHarnessFake = () => {
  const listeners = new Set<(event: AgentHarnessEvent) => void>()
  const state = { abortCount: 0 }
  const harness = {
    subscribe: (listener: (event: AgentHarnessEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    abort: async () => {
      state.abortCount += 1
      return { clearedSteer: [], clearedFollowUp: [] }
    },
  } as unknown as AgentHarness
  return {
    harness,
    state,
    listenerCount: () => listeners.size,
    emit: (event: AgentHarnessEvent): void => listeners.forEach((listener) => listener(event)),
  }
}

describe('piHarnessToUiMessageStream abort', () => {
  it('consumer cancellation settles immediately and preserves the late stopped reply', async () => {
    const { harness, emit } = createHarnessEvents()
    const stopping = Promise.withResolvers<void>()
    const preserved = Promise.withResolvers<void>()
    const appended: unknown[] = []
    harness.abort = async () => {
      await stopping.promise
      emit({
        type: 'message_end',
        message: {
          ...assistantMessage,
          content: [{ type: 'text', text: 'partial answer' }],
          stopReason: 'aborted',
        },
      })
      return { clearedSteer: [], clearedFollowUp: [] }
    }
    harness.appendMessage = async (message) => {
      appended.push(message)
      preserved.resolve()
    }
    const stream = piHarnessToUiMessageStream(harness, () => {
      emit({ type: 'agent_start' })
      return stopping.promise
    })
    await stream.cancel()
    expect(appended).toEqual([])
    stopping.resolve()
    await preserved.promise
    expect(appended).toHaveLength(1)
    expect(JSON.stringify(appended[0])).toContain('partial answer')
    expect(appended[0]).toMatchObject({ stopReason: 'stop' })
  })

  it('closes the stream and aborts the harness when the signal fires mid-run', async () => {
    const { harness, state, emit, listenerCount } = createHarnessFake()
    const controller = new AbortController()
    // The harness never settles on its own — only the abort can end this stream,
    // which is the regression: Stop used to leave the loop running forever.
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        emit({ type: 'agent_start' } as AgentHarnessEvent)
        emit({ type: 'turn_start' } as AgentHarnessEvent)
        return new Promise<void>(() => {})
      },
      {},
      controller.signal,
    )

    const consumed = new Response(stream).text()
    controller.abort()
    const output = await consumed

    expect(state.abortCount).toBe(1)
    expect(listenerCount()).toBe(0)
    // The turn settles as a well-formed message rather than a dangling step.
    expect(output).toContain('"type":"finish-step"')
    expect(output).toContain('"type":"finish"')
    expect(output).toContain('[DONE]')
  })

  it('closes the open reasoning part so its spinner stops', async () => {
    const { harness, emit } = createHarnessFake()
    const controller = new AbortController()
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        emit({ type: 'agent_start' } as AgentHarnessEvent)
        emit({ type: 'turn_start' } as AgentHarnessEvent)
        emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
        } as AgentHarnessEvent)
        return new Promise<void>(() => {})
      },
      {},
      controller.signal,
    )

    const consumed = new Response(stream).text()
    controller.abort()

    expect(await consumed).toContain('"type":"reasoning-end"')
  })

  it('emits nothing when the signal aborts before the first chunk', async () => {
    const { harness, state } = createHarnessFake()
    const controller = new AbortController()
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        // Reached only if the abort failed to short-circuit the run.
        state.abortCount = -1
        return new Promise<void>(() => {})
      },
      {},
      controller.signal,
    )

    const consumed = new Response(stream).text()
    controller.abort()
    const output = await consumed

    // A synthetic start/finish here would read as an empty assistant turn, and
    // the chat auto-retries those — restarting the turn the user cancelled.
    expect(output).not.toContain('"type":"start"')
    expect(output).not.toContain('"type":"finish"')
    expect(output).toContain('[DONE]')
  })

  it('never starts the run when the signal is already aborted', async () => {
    const { harness, state } = createHarnessFake()
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        state.abortCount = -1
        return new Promise<void>(() => {})
      },
      {},
      AbortSignal.abort(),
    )

    const output = await new Response(stream).text()

    expect(state.abortCount).toBe(0)
    expect(output).toBe('data: [DONE]\n\n')
  })
})

/** The text of an assistant message as the provider receives it. */
const assistantText = (message: Message | undefined): string =>
  message?.role === 'assistant'
    ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    : ''

/** Run one chat turn through the bridge, pressing Stop once `stopAt` shows up in the stream. */
const sendTurn = async (harness: AgentHarness, text: string, stop?: AbortController, stopAt?: string) => {
  const stream = piHarnessToUiMessageStream(
    harness,
    async () => {
      await harness.prompt(text)
      await harness.waitForIdle()
    },
    {},
    stop?.signal,
  )
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    if (stopAt && decoder.decode(chunk, { stream: true }).includes(stopAt)) {
      stop?.abort()
    }
  }
  await harness.waitForIdle()
}

/**
 * Drive a real harness over three turns, stopping the second, and return what
 * the provider receives on the third. pi-ai's `transformMessages` is the step
 * every provider applies to the session before sending it.
 */
const historyAfterStop = async (options: {
  stoppedReply: (stop: AbortController) => AssistantMessage
  stopAt?: string
  tools?: (stop: AbortController) => AgentHarnessTool<undefined>[]
}) => {
  const faux = fauxProvider({ tokensPerSecond: 1000 })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  const stop = new AbortController()
  const sent: Message[] = []
  const tools = options.tools?.(stop) ?? []
  const harness = new AgentHarness({
    session: await new InMemorySessionRepo().create({}),
    models,
    model,
    tools,
    activeToolNames: tools.map((tool) => tool.name),
  })

  faux.setResponses([fauxAssistantMessage('Noted.')])
  await sendTurn(harness, 'I live in Lisbon.')
  // The spare answers the extra model call Pi makes after an aborted tool, if any.
  faux.setResponses([() => options.stoppedReply(stop), fauxAssistantMessage('spare')])
  await sendTurn(harness, 'Write a long essay about Lisbon.', stop, options.stopAt)
  const capture: FauxResponseStep = (context) => {
    sent.push(...transformMessages(context.messages, model))
    return fauxAssistantMessage('You live in Lisbon.')
  }
  faux.setResponses([capture])
  await sendTurn(harness, 'Which city do I live in?')
  return sent
}

const essay = 'Lisbon grew up on seven hills above the Tagus. '.repeat(200)

describe('piHarnessToUiMessageStream after Stop', () => {
  it('keeps the partial reply so the model does not write it again', async () => {
    const sent = await historyAfterStop({ stoppedReply: () => fauxAssistantMessage(essay), stopAt: '"text-delta"' })

    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    const partial = assistantText(sent[3])
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(essay.trim().length)
    expect(essay.startsWith(partial)).toBe(true)
  })

  it('answers the stopped prompt with a marker when Stop came before the first token', async () => {
    const sent = await historyAfterStop({
      stoppedReply: (stop) => {
        stop.abort()
        return fauxAssistantMessage(essay)
      },
    })

    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(assistantText(sent[3])).toBe(stoppedReplyMarker)
  })

  it('answers the stopped prompt with a marker when Stop came during reasoning', async () => {
    const sent = await historyAfterStop({
      stoppedReply: () => fauxAssistantMessage([fauxThinking('Let me plan the essay. '.repeat(200)), fauxText(essay)]),
      stopAt: '"reasoning-delta"',
    })

    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(assistantText(sent[3])).toBe(stoppedReplyMarker)
  })

  it('answers the stopped prompt with a marker when Stop came during a tool call', async () => {
    const sent = await historyAfterStop({
      stoppedReply: () => fauxAssistantMessage(fauxToolCall('search', {}), { stopReason: 'toolUse' }),
      tools: (stop) => [
        {
          name: 'search',
          label: 'Search',
          description: 'Search the web',
          parameters: Type.Object({}),
          execute: async () => {
            stop.abort()
            throw new Error('aborted')
          },
        },
      ],
    })

    expect(sent.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'toolResult',
      'assistant',
      'user',
    ])
    expect(assistantText(sent[5])).toBe(stoppedReplyMarker)
  })
})
