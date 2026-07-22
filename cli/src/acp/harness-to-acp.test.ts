/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the pure Pi→ACP translation: the `toToolKind` / `toAcpStopReason`
 * mapping tables and the per-event `createHarnessToAcpTranslator` branching
 * (every harness event → zero or one ACP SessionUpdate, including the
 * tool-result content extraction and the lifecycle drop-through).
 */

import { describe, expect, test } from 'bun:test'
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent, StopReason as PiStopReason } from '@earendil-works/pi-ai'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { createHarnessToAcpTranslator, toAcpStopReason, toToolKind } from './harness-to-acp.ts'

/** Build a `message_update` event around an inner assistant-message delta. The
 *  translator only reads `assistantMessageEvent`, so `message` is elided. */
const messageUpdate = (inner: Partial<AssistantMessageEvent> & { type: string }): AgentHarnessEvent =>
  ({ type: 'message_update', assistantMessageEvent: inner } as unknown as AgentHarnessEvent)

/** Collect every update the translator emits for a single event. */
const translate = (event: AgentHarnessEvent): SessionUpdate[] => {
  const out: SessionUpdate[] = []
  createHarnessToAcpTranslator((u) => out.push(u)).handle(event)
  return out
}

describe('toToolKind', () => {
  test('maps built-in coding and web tools to their ACP kinds', () => {
    expect(toToolKind('bash')).toBe('execute')
    expect(toToolKind('read')).toBe('read')
    expect(toToolKind('write')).toBe('edit')
    expect(toToolKind('edit')).toBe('edit')
    expect(toToolKind('webfetch')).toBe('fetch')
  })

  test('falls back to `other` for any unknown / empty tool name', () => {
    expect(toToolKind('grep')).toBe('other')
    expect(toToolKind('')).toBe('other')
    expect(toToolKind('BASH')).toBe('other') // case-sensitive: not the same key
  })
})

describe('toAcpStopReason', () => {
  test('length → max_tokens, aborted → cancelled', () => {
    expect(toAcpStopReason('length')).toBe('max_tokens')
    expect(toAcpStopReason('aborted')).toBe('cancelled')
  })

  test('stop / toolUse / error all collapse to end_turn', () => {
    const collapsing: PiStopReason[] = ['stop', 'toolUse', 'error']
    for (const reason of collapsing) expect(toAcpStopReason(reason)).toBe('end_turn')
  })
})

describe('createHarnessToAcpTranslator — message_update', () => {
  test('text_delta → a single agent_message_chunk carrying the delta', () => {
    const out = translate(messageUpdate({ type: 'text_delta', delta: 'hello' }))
    expect(out).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }])
  })

  test('thinking_delta → agent_thought_chunk, not a message chunk', () => {
    const out = translate(messageUpdate({ type: 'thinking_delta', delta: 'pondering' }))
    expect(out).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } }])
  })

  test('a non-delta inner event (text_start) emits nothing', () => {
    expect(translate(messageUpdate({ type: 'text_start' }))).toEqual([])
  })
})

describe('createHarnessToAcpTranslator — tool_execution_start', () => {
  test('emits an in_progress tool_call with the mapped kind and forwarded args', () => {
    const out = translate({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'ls' },
    } as AgentHarnessEvent)
    expect(out).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      },
    ])
  })

  test('an unknown tool keeps its title but degrades kind to `other`', () => {
    const [update] = translate({
      type: 'tool_execution_start',
      toolCallId: 't2',
      toolName: 'curl',
      args: {},
    } as AgentHarnessEvent)
    expect(update).toMatchObject({ title: 'curl', kind: 'other' })
  })

  test('missing args default to an empty rawInput object', () => {
    const [update] = translate({
      type: 'tool_execution_start',
      toolCallId: 't3',
      toolName: 'read',
      args: undefined,
    } as unknown as AgentHarnessEvent)
    expect(update).toMatchObject({ rawInput: {} })
  })
})

describe('createHarnessToAcpTranslator — tool_execution_end', () => {
  const end = (result: unknown, isError: boolean): AgentHarnessEvent =>
    ({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result, isError } as AgentHarnessEvent)

  /** Translate an end event and narrow to the `tool_call_update` variant so its
   *  `content` / `rawOutput` fields are typed. */
  const update = (result: unknown, isError: boolean) => {
    const [u] = translate(end(result, isError))
    if (u.sessionUpdate !== 'tool_call_update') throw new Error(`expected tool_call_update, got ${u.sessionUpdate}`)
    return u
  }

  test('a successful result → completed, forwarding rawOutput and text content', () => {
    const result = { content: [{ type: 'text', text: 'done' }] }
    const out = translate(end(result, false))
    expect(out).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        rawOutput: result,
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
      },
    ])
  })

  test('isError flips the status to failed and still forwards rawOutput', () => {
    const result = { content: [{ type: 'text', text: 'boom' }] }
    expect(update(result, true)).toMatchObject({ status: 'failed', toolCallId: 't1', rawOutput: result })
  })

  test('selects blocks by a string `text` field, regardless of declared `type`', () => {
    // The predicate keys off `text` presence, not `type`: a block typed `image`
    // but carrying a `text` string is kept; blocks without `text` are dropped.
    const result = {
      content: [
        { type: 'image', data: 'xxx' }, // no `text` → dropped
        { type: 'image', text: 'alt-kept' }, // has `text` → kept despite type
        { type: 'text', text: 'keep me' },
        { type: 'resource' }, // no `text` → dropped
      ],
    }
    expect(update(result, false).content).toEqual([
      { type: 'content', content: { type: 'text', text: 'alt-kept' } },
      { type: 'content', content: { type: 'text', text: 'keep me' } },
    ])
  })

  test('multiple text blocks all survive, in order', () => {
    const result = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }
    expect(update(result, false).content).toEqual([
      { type: 'content', content: { type: 'text', text: 'a' } },
      { type: 'content', content: { type: 'text', text: 'b' } },
    ])
  })

  test('a result with no text blocks yields undefined content (relies on rawOutput)', () => {
    const u = update({ content: [{ type: 'image', data: 'x' }] }, false)
    expect(u.content).toBeUndefined()
    expect(u.rawOutput).toEqual({ content: [{ type: 'image', data: 'x' }] })
  })

  test('a result without a content array yields undefined content', () => {
    expect(update({ details: {} }, false).content).toBeUndefined()
  })

  test('a non-object / null result yields undefined content but still completes', () => {
    expect(update(null, false)).toMatchObject({ status: 'completed', content: undefined })
  })
})

describe('createHarnessToAcpTranslator — lifecycle / unmapped events', () => {
  test('lifecycle and intermediate events produce no session update', () => {
    const dropped: AgentHarnessEvent[] = [
      { type: 'agent_start' } as AgentHarnessEvent,
      { type: 'turn_start' } as AgentHarnessEvent,
      { type: 'turn_end', message: {}, toolResults: [] } as unknown as AgentHarnessEvent,
      { type: 'message_start' } as unknown as AgentHarnessEvent,
      { type: 'message_end' } as unknown as AgentHarnessEvent,
      { type: 'agent_end', messages: [] } as unknown as AgentHarnessEvent,
      {
        type: 'tool_execution_update',
        toolCallId: 't1',
        toolName: 'bash',
        args: {},
        partialResult: {},
      } as AgentHarnessEvent,
    ]
    for (const event of dropped) expect(translate(event)).toEqual([])
  })
})

describe('createHarnessToAcpTranslator — stateless ordering across a sequence', () => {
  test('one translator preserves emit order and drops lifecycle events inline', () => {
    const out: SessionUpdate[] = []
    const { handle } = createHarnessToAcpTranslator((u) => out.push(u))
    // A realistic turn: lifecycle → text → tool start → tool end → lifecycle.
    handle({ type: 'turn_start' } as AgentHarnessEvent)
    handle(messageUpdate({ type: 'text_delta', delta: 'one ' }))
    handle(messageUpdate({ type: 'text_delta', delta: 'two' }))
    handle({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'read', args: { path: 'a' } } as AgentHarnessEvent)
    handle({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'read', result: { content: [] }, isError: false } as AgentHarnessEvent)
    handle({ type: 'turn_end', message: {}, toolResults: [] } as unknown as AgentHarnessEvent)

    expect(out.map((u) => u.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ])
  })
})
