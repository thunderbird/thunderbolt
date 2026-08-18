/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ThunderboltUIMessage } from '@/types'
import { buildDebugTranscriptPayload } from './build-payload'
import {
  beginDebugTranscriptTurn,
  clearDebugTranscriptRecorder,
  finishDebugTranscriptTurn,
  recordDebugTranscriptFailure,
  recordDebugTranscriptSystemPrompts,
  setDebugTranscriptCaptureEnabled,
} from './recorder'

const metadata = {
  traceId: 'trace-notes',
  engine: 'pi' as const,
  modelId: 'model-1',
  modelName: 'Claude',
  provider: 'anthropic',
  agentId: 'built-in',
}

describe('buildDebugTranscriptPayload', () => {
  beforeEach(() => {
    setDebugTranscriptCaptureEnabled(true)
    clearDebugTranscriptRecorder()
  })
  afterEach(() => {
    setDebugTranscriptCaptureEnabled(false)
    clearDebugTranscriptRecorder()
  })

  it('walks persisted messages in order and staples notes on by user message id', () => {
    beginDebugTranscriptTurn({
      threadId: 'thread-1',
      traceId: 'trace-notes',
      engine: 'pi',
      model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
      agentId: 'built-in',
      userMessageId: 'user-middle',
    })
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-notes', [
      'Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    ])
    finishDebugTranscriptTurn('thread-1', 'trace-notes', 'success', 'pi')
    const messages: ThunderboltUIMessage[] = [
      { id: 'user-first', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
      { id: 'assistant-first', role: 'assistant', parts: [{ type: 'text', text: 'First answer' }] },
      {
        id: 'user-middle',
        role: 'user',
        parts: [{ type: 'text', text: 'Middle question' }],
        metadata: { debugTranscript: metadata },
      },
      {
        id: 'assistant-middle',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Persisted middle answer' }],
        metadata: { debugTranscript: metadata },
      },
      { id: 'user-last', role: 'user', parts: [{ type: 'text', text: 'Last question' }] },
      { id: 'assistant-last', role: 'assistant', parts: [{ type: 'text', text: 'Last answer' }] },
    ]

    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages,
      authSession: { user: { id: 'user-1', email: 'user@example.com' } },
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(payload.turns.map(({ userMessageId, source }) => ({ userMessageId, source }))).toEqual([
      { userMessageId: 'user-first', source: 'persisted' },
      { userMessageId: 'user-middle', source: 'live' },
      { userMessageId: 'user-last', source: 'persisted' },
    ])
    expect(payload.turns[1]?.assistantOutput?.text).toBe('Persisted middle answer')
    expect(payload.turns[1]?.systemPrompts).toEqual([
      expect.objectContaining({ text: 'Use Authorization: [redacted]', attempt: 1 }),
    ])
    expect(payload.capture).toEqual({
      capturedAt: '2026-08-18T12:00:00.000Z',
      appVersion: '1.2.3',
      platform: 'web',
      recorderDisabled: false,
    })
  })

  it('attaches the note matching authoritative retry metadata', () => {
    beginDebugTranscriptTurn({
      threadId: 'thread-1',
      traceId: 'trace-abandoned',
      engine: 'legacy',
      model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
      agentId: 'built-in',
      userMessageId: 'user-retry',
    })
    recordDebugTranscriptFailure('thread-1', 'trace-abandoned', {
      errorClass: 'OldError',
      message: 'abandoned attempt',
    })
    finishDebugTranscriptTurn('thread-1', 'trace-abandoned', 'error', 'legacy')
    beginDebugTranscriptTurn({
      threadId: 'thread-1',
      traceId: 'trace-authoritative',
      engine: 'pi',
      model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
      agentId: 'built-in',
      userMessageId: 'user-retry',
    })
    recordDebugTranscriptFailure('thread-1', 'trace-authoritative', {
      errorClass: 'NewError',
      message: 'authoritative attempt',
    })
    finishDebugTranscriptTurn('thread-1', 'trace-authoritative', 'error', 'pi')
    const authoritativeMetadata = { ...metadata, traceId: 'trace-authoritative' }

    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages: [
        {
          id: 'user-retry',
          role: 'user',
          parts: [{ type: 'text', text: 'Retry this' }],
          metadata: { debugTranscript: authoritativeMetadata },
        },
        {
          id: 'assistant-retry',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Final answer' }],
          metadata: { debugTranscript: authoritativeMetadata },
        },
      ],
      authSession: null,
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(payload.turns[0]).toMatchObject({
      traceId: 'trace-authoritative',
      outcome: 'error',
      failures: [{ errorClass: 'NewError', message: 'authoritative attempt' }],
    })
  })

  it('extracts tools from persisted parts with optional duration metadata', () => {
    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages: [
        { id: 'user-tools', role: 'user', parts: [{ type: 'text', text: 'Use tools' }] },
        {
          id: 'assistant-tools',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'lookup',
              toolCallId: 'call-timed',
              state: 'output-available',
              input: { query: 'status' },
              output: { status: 'ok' },
            },
            {
              type: 'dynamic-tool',
              toolName: 'notify',
              toolCallId: 'call-untimed',
              state: 'output-error',
              input: { message: 'hello' },
              errorText: 'failed',
            },
          ],
          metadata: { reasoningTime: { 'call-timed': 12 } },
        },
      ],
      authSession: null,
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(payload.turns[0]?.toolCalls).toEqual([
      {
        toolCallId: 'call-timed',
        name: 'lookup',
        arguments: { query: 'status' },
        result: { status: 'ok' },
        status: 'ok',
        durationMs: 12,
      },
      {
        toolCallId: 'call-untimed',
        name: 'notify',
        arguments: { message: 'hello' },
        result: 'failed',
        status: 'error',
        durationMs: null,
      },
    ])
  })

  it('keeps one turn and replaces an oversized tool value', () => {
    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages: [
        { id: 'user-large-tool', role: 'user', parts: [{ type: 'text', text: 'Use the large tool' }] },
        {
          id: 'assistant-large-tool',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'large-result',
              toolCallId: 'call-large',
              state: 'output-available',
              input: { query: 'status' },
              output: { body: 'x'.repeat(1_600_000) },
            },
          ],
        },
      ],
      authSession: null,
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(payload.turns).toHaveLength(1)
    expect(payload.turns[0]?.toolCalls[0]?.result).toBe('[value too large]')
  })

  it('reconstructs an orphan assistant as a synthetic turn', () => {
    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages: [{ id: 'assistant-orphan', role: 'assistant', parts: [{ type: 'text', text: 'Welcome' }] }],
      authSession: null,
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(payload.turns).toEqual([
      expect.objectContaining({
        traceId: 'persisted:assistant:assistant-orphan',
        userMessageId: null,
        assistantMessageId: 'assistant-orphan',
        userPrompt: { text: '', timestamp: null },
        assistantOutput: { text: 'Welcome', timestamp: null },
      }),
    ])
  })

  it('sanitizes the assembled payload before returning it', () => {
    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages: [
        {
          id: 'user-secret',
          role: 'user',
          parts: [{ type: 'text', text: 'Request failed with sk-proj-abcdefghijklmnopqrstuvwxyz123456' }],
        },
      ],
      authSession: null,
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(payload.turns[0]?.userPrompt.text).toBe('Request failed with [redacted]')
  })

  it('drops oldest persisted turns until the payload is at most 1.5 MB', () => {
    const payload = buildDebugTranscriptPayload({
      threadId: 'thread-1',
      messages: [
        { id: 'user-large', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(1_600_000) }] },
        { id: 'assistant-large', role: 'assistant', parts: [{ type: 'text', text: 'Large answer' }] },
        { id: 'user-recent', role: 'user', parts: [{ type: 'text', text: 'Recent question' }] },
        { id: 'assistant-recent', role: 'assistant', parts: [{ type: 'text', text: 'Recent answer' }] },
      ],
      authSession: null,
      appVersion: '1.2.3',
      platform: 'web',
      capturedAt: '2026-08-18T12:00:00.000Z',
    })

    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(1_500_000)
    expect(payload.turns.map(({ userMessageId }) => userMessageId)).toEqual(['user-recent'])
  })
})
