/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Exercises the disk-backed {@link createSessionStore} against a real temp
 * directory (no mocks): a session persisted by one store instance rehydrates on
 * a *fresh* instance — proving the entry log survives a process restart, which
 * is the whole point of `session/resume` — and the resume path trims an
 * incomplete trailing turn so the next prompt starts clean.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import { createSessionStore } from './session-store.ts'

const CWD = '/workspace/project'

const userMessage = (text: string): UserMessage => ({ role: 'user', content: text, timestamp: 0 })

const assistantText = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'fake',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: 0,
})

const assistantToolCall = (toolCallId: string, name: string): AssistantMessage => ({
  ...assistantText(''),
  content: [{ type: 'toolCall', id: toolCallId, name, arguments: { command: 'echo hi' } }],
  stopReason: 'toolUse',
})

const toolResult = (toolCallId: string, name: string): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: name,
  content: [{ type: 'text', text: 'hi' }],
  isError: false,
  timestamp: 0,
})

describe('createSessionStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'thunderbolt-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a persisted session rehydrates full execution context on a fresh store', async () => {
    const writer = createSessionStore(dir)
    const session = await writer.createSession('s1', CWD)
    await session.appendThinkingLevelChange('high')
    await session.appendMessage(userMessage('build it'))
    await session.appendMessage(assistantToolCall('t1', 'bash'))
    await session.appendMessage(toolResult('t1', 'bash'))
    await session.appendMessage(assistantText('done'))

    // A brand-new store instance over the same dir = a fresh process resuming.
    const resumed = await createSessionStore(dir).openOrCreate('s1', CWD)
    const context = await resumed.buildContext()

    expect(context.messages).toHaveLength(4)
    expect(context.messages[0]).toMatchObject({ role: 'user', content: 'build it' })
    // The tool call AND its result survive — execution continuity, not just text.
    expect(context.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', id: 't1' }] })
    expect(context.messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 't1' })
    expect(context.messages[3]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    // A non-message entry (thinking level) is preserved too.
    expect(context.thinkingLevel).toBe('high')
  })

  test('an unknown id self-heals to a fresh empty session (no throw)', async () => {
    const resumed = await createSessionStore(dir).openOrCreate('never-persisted', CWD)
    expect((await resumed.buildContext()).messages).toHaveLength(0)
    expect((await resumed.getMetadata()).id).toBe('never-persisted')
  })

  test('resume drops a trailing dangling tool_use (killed mid-turn)', async () => {
    const writer = createSessionStore(dir)
    const session = await writer.createSession('s2', CWD)
    await session.appendMessage(assistantText('earlier answer')) // last clean boundary
    await session.appendMessage(userMessage('do more'))
    await session.appendMessage(assistantToolCall('t9', 'bash')) // no tool_result → dangling

    const resumed = await createSessionStore(dir).openOrCreate('s2', CWD)
    const context = await resumed.buildContext()

    expect(context.messages).toHaveLength(1)
    expect(context.messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] })
  })

  test('resume drops a trailing bare user prompt (killed before the reply)', async () => {
    const writer = createSessionStore(dir)
    const session = await writer.createSession('s3', CWD)
    await session.appendMessage(assistantText('earlier answer'))
    await session.appendMessage(userMessage('unanswered'))

    const resumed = await createSessionStore(dir).openOrCreate('s3', CWD)
    const context = await resumed.buildContext()

    expect(context.messages).toHaveLength(1)
    expect(context.messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] })
  })

  test('resume leaves a clean session untouched', async () => {
    const writer = createSessionStore(dir)
    const session = await writer.createSession('s4', CWD)
    await session.appendMessage(userMessage('hi'))
    await session.appendMessage(assistantText('hello'))

    const resumed = await createSessionStore(dir).openOrCreate('s4', CWD)
    expect((await resumed.buildContext()).messages).toHaveLength(2)
  })
})
