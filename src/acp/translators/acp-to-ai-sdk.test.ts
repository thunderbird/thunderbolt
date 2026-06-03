/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Translator unit tests. The translator state is exercised through `emit`
 * collection (an array) rather than the SSE byte stream — wire encoding is
 * trivial and orthogonal to the mapping logic. The stream-end + finish path
 * is covered indirectly by `createTranslatorStream` (one test below).
 */

import '@/testing-library'

import { act } from '@testing-library/react'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { createTranslator, createTranslatorStream } from './acp-to-ai-sdk'
import type { AiSdkChunk } from '../types'

const notification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'sess-1',
  update,
})

const collect = (): { emit: (c: AiSdkChunk) => void; chunks: AiSdkChunk[] } => {
  const chunks: AiSdkChunk[] = []
  return { emit: (c) => chunks.push(c), chunks }
}

describe('createTranslator — mapping', () => {
  it('agent_message_chunk (text) emits text-start once then throttled text-delta', async () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit, { textDeltaThrottleMs: 200 })
    t.start()
    t.handle(notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } }))
    t.handle(notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }))
    // Before the throttle fires, only start chunks are out.
    expect(chunks.map((c) => c.type)).toEqual(['start', 'start-step', 'text-start'])
    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(chunks.map((c) => c.type)).toEqual(['start', 'start-step', 'text-start', 'text-delta'])
    const delta = chunks.find((c) => c.type === 'text-delta')
    expect(delta).toMatchObject({ type: 'text-delta', delta: 'hello world' })
  })

  it('5 sequential text-deltas inside the throttle window coalesce into 1 emit', async () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit, { textDeltaThrottleMs: 200 })
    t.start()
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      t.handle(notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }))
    }
    await act(async () => {
      await getClock().tickAsync(200)
    })
    const deltas = chunks.filter((c) => c.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ delta: 'abcde' })
  })

  it('agent_thought_chunk emits reasoning-start + reasoning-delta', async () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit, { textDeltaThrottleMs: 100 })
    t.start()
    t.handle(notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } }))
    await act(async () => {
      await getClock().tickAsync(100)
    })
    expect(chunks.map((c) => c.type)).toContain('reasoning-start')
    expect(chunks.map((c) => c.type)).toContain('reasoning-delta')
    const r = chunks.find((c) => c.type === 'reasoning-delta')
    expect(r).toMatchObject({ delta: 'thinking...' })
  })

  it('tool_call emits tool-input-start + tool-input-available', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'search',
        rawInput: { query: 'foo' },
      }),
    )
    const toolChunks = chunks.filter((c) => c.type.startsWith('tool-'))
    expect(toolChunks.map((c) => c.type)).toEqual(['tool-input-start', 'tool-input-available'])
    expect(toolChunks[1]).toMatchObject({ toolCallId: 'tc1', input: { query: 'foo' } })
  })

  it('tool_call_update (in_progress) emits nothing; (completed) emits tool-output-available', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'search',
        rawInput: {},
      }),
    )
    const beforeUpdate = chunks.length
    t.handle(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'in_progress',
      }),
    )
    expect(chunks.length).toBe(beforeUpdate)

    t.handle(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        rawOutput: { result: 'ok' },
      }),
    )
    const output = chunks.find((c) => c.type === 'tool-output-available')
    expect(output).toMatchObject({ type: 'tool-output-available', toolCallId: 'tc1', output: { result: 'ok' } })
  })

  it('tool_call_update (failed) emits tool-output-error', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'failed',
        rawOutput: 'boom',
      }),
    )
    const last = chunks[chunks.length - 1]
    expect(last).toMatchObject({ type: 'tool-output-error', toolCallId: 'tc1', errorText: 'boom' })
  })

  it('plan / available_commands_update / current_mode_update are ignored', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    const before = chunks.length
    t.handle(notification({ sessionUpdate: 'plan', entries: [] }))
    t.handle(notification({ sessionUpdate: 'available_commands_update', availableCommands: [] }))
    t.handle(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' }))
    expect(chunks.length).toBe(before)
  })

  it('finish flushes buffered text-delta and emits text-end + finish-step + finish', async () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit, { textDeltaThrottleMs: 10_000 })
    t.start()
    t.handle(notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final' } }))
    // No clock tick — confirm finish() drains without waiting for throttle.
    t.finish()
    const types = chunks.map((c) => c.type)
    expect(types).toContain('text-delta')
    expect(types).toContain('text-end')
    expect(types[types.length - 2]).toBe('finish-step')
    expect(types[types.length - 1]).toBe('finish')
    const delta = chunks.find((c) => c.type === 'text-delta')
    expect(delta).toMatchObject({ delta: 'final' })
  })

  it('error emits a terminal error chunk', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.error('upstream blew up')
    const last = chunks[chunks.length - 1]
    expect(last).toMatchObject({ type: 'error', errorText: 'upstream blew up' })
  })
})

describe('createTranslator — action durations', () => {
  // Injectable epoch-millis clock the translator reads via `options.now`. We
  // advance `value` between events so durations are deterministic and never read
  // the real wall clock.
  const fakeClock = () => {
    let value = 0
    return { now: () => value, advance: (ms: number) => (value += ms) }
  }

  it('emits reasoningTime keyed by toolCallId for a completed tool_call', () => {
    const { emit, chunks } = collect()
    const clock = fakeClock()
    const t = createTranslator(emit, { now: clock.now })
    t.start()
    t.handle(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'search', rawInput: {} }))
    clock.advance(250)
    t.handle(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', rawOutput: {} }))

    const meta = chunks.filter((c) => c.type === 'message-metadata')
    expect(meta).toHaveLength(1)
    expect(meta[0]).toMatchObject({ type: 'message-metadata', messageMetadata: { reasoningTime: { tc1: 250 } } })
  })

  it('emits reasoningTime for a failed tool_call too', () => {
    const { emit, chunks } = collect()
    const clock = fakeClock()
    const t = createTranslator(emit, { now: clock.now })
    t.start()
    t.handle(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'search', rawInput: {} }))
    clock.advance(40)
    t.handle(
      notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed', rawOutput: 'boom' }),
    )

    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toMatchObject({ type: 'message-metadata', messageMetadata: { reasoningTime: { tc1: 40 } } })
  })

  it('does not re-emit a duration on a second terminal update for the same tool', () => {
    const { emit, chunks } = collect()
    const clock = fakeClock()
    const t = createTranslator(emit, { now: clock.now })
    t.start()
    t.handle(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'search', rawInput: {} }))
    clock.advance(10)
    t.handle(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', rawOutput: {} }))
    clock.advance(10)
    t.handle(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', rawOutput: {} }))

    expect(chunks.filter((c) => c.type === 'message-metadata')).toHaveLength(1)
  })

  it('tracks independent durations per concurrent tool call', () => {
    const { emit, chunks } = collect()
    const clock = fakeClock()
    const t = createTranslator(emit, { now: clock.now })
    t.start()
    t.handle(notification({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'read', rawInput: {} }))
    clock.advance(100)
    t.handle(notification({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'grep', rawInput: {} }))
    clock.advance(100)
    t.handle(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: {} }))
    clock.advance(50)
    t.handle(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed', rawOutput: {} }))

    const durations = chunks
      .filter((c) => c.type === 'message-metadata')
      .map((c) => (c.messageMetadata as { reasoningTime: Record<string, number> }).reasoningTime)
    expect(durations).toEqual([{ a: 200 }, { b: 150 }])
  })

  it('emits reasoningTime keyed to reasoning-0 when reasoning ends at text-start', async () => {
    const { emit, chunks } = collect()
    const clock = fakeClock()
    const t = createTranslator(emit, { now: clock.now, textDeltaThrottleMs: 100 })
    t.start()
    t.handle(notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }))
    clock.advance(300)
    // First text chunk marks the reasoning→text boundary.
    t.handle(notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }))

    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toMatchObject({ type: 'message-metadata', messageMetadata: { reasoningTime: { 'reasoning-0': 300 } } })
    await act(async () => {
      await getClock().tickAsync(100)
    })
  })

  it('emits reasoning-0 duration at finish for a reasoning-only turn (no text)', () => {
    const { emit, chunks } = collect()
    const clock = fakeClock()
    const t = createTranslator(emit, { now: clock.now, textDeltaThrottleMs: 100 })
    t.start()
    t.handle(notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }))
    clock.advance(120)
    t.finish()

    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toMatchObject({ type: 'message-metadata', messageMetadata: { reasoningTime: { 'reasoning-0': 120 } } })
  })
})

describe('createTranslatorStream — wire format', () => {
  it('encodes chunks as `data: <json>\\n\\n` and emits [DONE] on close', async () => {
    const { body, translator, close } = createTranslatorStream({ textDeltaThrottleMs: 50 })
    translator.start()
    translator.handle(notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }))
    await act(async () => {
      await getClock().tickAsync(50)
    })
    translator.finish()
    close()

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    expect(text).toContain('data: {"type":"start"}\n\n')
    expect(text).toContain('data: {"type":"text-start"')
    expect(text).toContain('"type":"text-delta"')
    expect(text).toContain('data: {"type":"finish"}\n\n')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })
})

describe('createTranslator — side effects', () => {
  it('current_mode_update emits mode_changed without any AI SDK chunk', () => {
    const { emit, chunks } = collect()
    const effects: unknown[] = []
    const t = createTranslator(emit, { onSideEffect: (e) => effects.push(e) })
    t.start()
    t.handle(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'rag' }))
    expect(chunks.map((c) => c.type)).toEqual(['start', 'start-step'])
    expect(effects).toEqual([{ type: 'mode_changed', modeId: 'rag' }])
  })

  it('config_option_update forwards configOptions array on the sink', () => {
    const { emit, chunks } = collect()
    const effects: unknown[] = []
    const t = createTranslator(emit, { onSideEffect: (e) => effects.push(e) })
    t.start()
    const options = [{ optionId: 'model', name: 'Model', type: 'select', value: 'gpt-4' }] as never
    t.handle(notification({ sessionUpdate: 'config_option_update', configOptions: options }))
    expect(chunks.map((c) => c.type)).toEqual(['start', 'start-step'])
    expect(effects).toEqual([{ type: 'config_options_changed', options }])
  })

  it('without a sink, side-effecting updates are silently ignored', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'rag' }))
    expect(chunks.map((c) => c.type)).toEqual(['start', 'start-step'])
  })
})

describe('createTranslator — haystack metadata', () => {
  it('emits message-metadata when agent_message_chunk carries haystackReferences in _meta', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'See [1].' },
        _meta: {
          haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf', pageNumber: 2 }],
        },
      }),
    )
    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toBeDefined()
    expect(meta).toMatchObject({
      type: 'message-metadata',
      messageMetadata: {
        haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf', pageNumber: 2 }],
      },
    })
  })

  it('accumulates references across chunks, sorted by position, with last writer wins per position', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'a' },
        _meta: {
          haystackReferences: [{ position: 2, fileId: 'f2', fileName: 'b.pdf' }],
        },
      }),
    )
    t.handle(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'b' },
        _meta: {
          haystackReferences: [
            { position: 1, fileId: 'f1', fileName: 'a.pdf' },
            { position: 2, fileId: 'f2-new', fileName: 'b-new.pdf' },
          ],
        },
      }),
    )

    const metaChunks = chunks.filter((c) => c.type === 'message-metadata')
    expect(metaChunks).toHaveLength(2)
    const last = metaChunks[metaChunks.length - 1]
    expect(last).toMatchObject({
      type: 'message-metadata',
      messageMetadata: {
        haystackReferences: [
          { position: 1, fileId: 'f1', fileName: 'a.pdf' },
          { position: 2, fileId: 'f2-new', fileName: 'b-new.pdf' },
        ],
      },
    })
  })

  it('passes haystackDocuments through alongside references', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x' },
        _meta: {
          haystackDocuments: [{ id: 'doc-1', content: 'snippet', score: 0.9, file: { id: 'f1', name: 'a.pdf' } }],
        },
      }),
    )
    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toMatchObject({
      type: 'message-metadata',
      messageMetadata: {
        haystackDocuments: [{ id: 'doc-1', content: 'snippet', score: 0.9, file: { id: 'f1', name: 'a.pdf' } }],
      },
    })
  })

  it('does not emit message-metadata when _meta is empty or lacks haystack keys', () => {
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x' },
        _meta: { unrelated: 'value' },
      }),
    )
    expect(chunks.some((c) => c.type === 'message-metadata')).toBe(false)
  })

  it('ingests notification-level _meta (Haystack adapter places it there per ACP spec)', () => {
    // Regression: the backend Haystack adapter puts `_meta` on the
    // `SessionNotification` itself (alongside `sessionId`/`update`), not on the
    // inner `update`. Without ingesting both, citations never reach the UI.
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.handle({
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'See [1].' },
      },
      _meta: {
        haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf' }],
      },
    })
    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toMatchObject({
      type: 'message-metadata',
      messageMetadata: {
        haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf' }],
      },
    })
  })

  it('ingestMeta surfaces a PromptResponse `_meta` payload outside the notification stream', () => {
    // The adapter awaits `connection.prompt(...)` whose `PromptResponse._meta`
    // mirrors the terminal citation metadata. We feed that into the translator
    // so the citations land even if the inline notification was dropped.
    const { emit, chunks } = collect()
    const t = createTranslator(emit)
    t.start()
    t.ingestMeta({
      haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf' }],
      haystackDocuments: [{ id: 'doc-1', content: 'snip', score: 0.9, file: { id: 'f1', name: 'a.pdf' } }],
    })
    const meta = chunks.find((c) => c.type === 'message-metadata')
    expect(meta).toMatchObject({
      type: 'message-metadata',
      messageMetadata: {
        haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'a.pdf' }],
        haystackDocuments: [{ id: 'doc-1', content: 'snip', score: 0.9, file: { id: 'f1', name: 'a.pdf' } }],
      },
    })
  })
})
