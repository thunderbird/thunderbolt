/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  beginDebugTranscriptTurn,
  clearDebugTranscriptRecorder,
  finishDebugTranscriptTurn,
  getDebugTranscriptCaptureStatus,
  getDebugTranscriptNotes,
  recordDebugTranscriptFailure,
  recordDebugTranscriptRetry,
  recordDebugTranscriptSystemPrompts,
  setDebugTranscriptCaptureEnabled,
} from './recorder'

const beginTurn = (traceId: string, threadId = 'thread-1') =>
  beginDebugTranscriptTurn({
    threadId,
    traceId,
    engine: 'pi',
    model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
    agentId: 'built-in',
    userMessageId: `user-${traceId}`,
  })

describe('debug transcript notes', () => {
  beforeEach(() => {
    setDebugTranscriptCaptureEnabled(true)
    clearDebugTranscriptRecorder()
  })
  afterEach(() => {
    setDebugTranscriptCaptureEnabled(false)
    clearDebugTranscriptRecorder()
  })

  it('records only turn metadata messages do not persist', () => {
    beginTurn('trace-1')
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-1', ['System prompt'])
    recordDebugTranscriptFailure('thread-1', 'trace-1', {
      errorClass: 'ProviderError',
      message: 'temporary failure',
    })
    finishDebugTranscriptTurn('thread-1', 'trace-1', 'success', 'pi')

    expect(getDebugTranscriptNotes('thread-1')[0]).toMatchObject({
      traceId: 'trace-1',
      userMessageId: 'user-trace-1',
      engine: 'pi',
      model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
      agentId: 'built-in',
      outcome: 'success',
      systemPrompts: [{ text: 'System prompt', attempt: 1 }],
      failures: [{ errorClass: 'ProviderError', message: 'temporary failure', attempt: 1, aborted: false }],
    })
  })

  it('skips the same system prompt batch on the second and third attempts', () => {
    beginTurn('trace-prompts')
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-prompts', ['Prompt A', 'Prompt B'])
    recordDebugTranscriptRetry('thread-1', 'trace-prompts', 'empty-response', 1)
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-prompts', ['Prompt A', 'Prompt B'])
    recordDebugTranscriptRetry('thread-1', 'trace-prompts', 'empty-response', 2)
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-prompts', ['Prompt A', 'Prompt B'])

    expect(getDebugTranscriptNotes('thread-1')[0]?.systemPrompts).toEqual([
      expect.objectContaining({ text: 'Prompt A', attempt: 1 }),
      expect.objectContaining({ text: 'Prompt B', attempt: 1 }),
    ])
  })

  it('records a changed system prompt batch with the attempt in progress', () => {
    beginTurn('trace-changed-prompts')
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-changed-prompts', ['Prompt A', 'Prompt B'])
    recordDebugTranscriptRetry('thread-1', 'trace-changed-prompts', 'empty-response', 1)
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-changed-prompts', ['Prompt A', 'Changed B'])

    expect(getDebugTranscriptNotes('thread-1')[0]?.systemPrompts).toEqual([
      expect.objectContaining({ text: 'Prompt A', attempt: 1 }),
      expect.objectContaining({ text: 'Prompt B', attempt: 1 }),
      expect.objectContaining({ text: 'Prompt A', attempt: 2 }),
      expect.objectContaining({ text: 'Changed B', attempt: 2 }),
    ])
  })

  it('records A to B to A prompt oscillation across attempts', () => {
    beginTurn('trace-oscillation')
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-oscillation', ['Prompt A'])
    recordDebugTranscriptRetry('thread-1', 'trace-oscillation', 'empty-response', 1)
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-oscillation', ['Prompt B'])
    recordDebugTranscriptRetry('thread-1', 'trace-oscillation', 'empty-response', 2)
    recordDebugTranscriptSystemPrompts('thread-1', 'trace-oscillation', ['Prompt A'])

    expect(getDebugTranscriptNotes('thread-1')[0]?.systemPrompts).toEqual([
      expect.objectContaining({ text: 'Prompt A', attempt: 1 }),
      expect.objectContaining({ text: 'Prompt B', attempt: 2 }),
      expect.objectContaining({ text: 'Prompt A', attempt: 3 }),
    ])
  })

  it('refreshes one existing note without discarding its user message id', () => {
    beginTurn('trace-refresh')
    beginDebugTranscriptTurn({
      threadId: 'thread-1',
      traceId: 'trace-refresh',
      engine: 'legacy',
      model: { id: 'model-2', name: 'GPT', provider: 'openai' },
      agentId: 'built-in',
    })

    expect(getDebugTranscriptNotes('thread-1')).toEqual([
      expect.objectContaining({
        traceId: 'trace-refresh',
        userMessageId: 'user-trace-refresh',
        engine: 'legacy',
        model: { id: 'model-2', name: 'GPT', provider: 'openai' },
      }),
    ])
  })

  it('updates the note to the engine resolved when the turn finishes', () => {
    beginDebugTranscriptTurn({
      threadId: 'thread-1',
      traceId: 'trace-engine',
      engine: 'legacy',
      model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
      agentId: 'built-in',
    })

    finishDebugTranscriptTurn('thread-1', 'trace-engine', 'error', 'pi')

    expect(getDebugTranscriptNotes('thread-1')[0]?.engine).toBe('pi')
  })

  it('latches closed after one internal error without discarding earlier notes', () => {
    beginTurn('trace-before-error')
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const throwingModel = {
      id: 'broken',
      name: 'Broken',
      get provider(): string {
        throw new Error('provider getter failed')
      },
    }

    try {
      beginDebugTranscriptTurn({
        threadId: 'thread-1',
        traceId: 'trace-broken',
        engine: 'pi',
        model: throwingModel,
        agentId: 'built-in',
      })
      beginTurn('trace-after-error')

      expect(getDebugTranscriptCaptureStatus().recorderDisabled).toBe(true)
      expect(getDebugTranscriptNotes('thread-1').map(({ traceId }) => traceId)).toEqual(['trace-before-error'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('attaches retry reasons and attempts to failures and aborts', () => {
    beginTurn('trace-retry')
    recordDebugTranscriptFailure('thread-1', 'trace-retry', {
      errorClass: 'ProviderError',
      message: 'retry me',
    })
    recordDebugTranscriptRetry('thread-1', 'trace-retry', 'provider-error', 1)
    finishDebugTranscriptTurn('thread-1', 'trace-retry', 'abort', 'pi')

    expect(getDebugTranscriptNotes('thread-1')[0]?.failures).toEqual([
      expect.objectContaining({ attempt: 1, retryReasons: ['provider-error'], aborted: false }),
      expect.objectContaining({ attempt: 2, retryReasons: ['provider-error'], aborted: true }),
    ])
  })

  it('keeps the last 50 turns per thread', () => {
    for (let index = 0; index < 51; index++) {
      beginTurn(`trace-${index}`)
    }

    const notes = getDebugTranscriptNotes('thread-1')
    expect(notes).toHaveLength(50)
    expect(notes[0]?.traceId).toBe('trace-1')
    expect(notes.at(-1)?.traceId).toBe('trace-50')
  })

  it('keeps the ten most recently touched threads', () => {
    for (let index = 0; index < 10; index++) {
      beginTurn(`trace-${index}`, `thread-${index}`)
    }
    recordDebugTranscriptSystemPrompts('thread-0', 'trace-0', ['Touch thread zero'])
    beginTurn('trace-10', 'thread-10')

    expect(getDebugTranscriptNotes('thread-0')).toHaveLength(1)
    expect(getDebugTranscriptNotes('thread-1')).toEqual([])
    expect(getDebugTranscriptNotes('thread-10')).toHaveLength(1)
  })

  it('clears on disable and re-enables without resurrecting notes', () => {
    beginTurn('trace-before')
    setDebugTranscriptCaptureEnabled(false)
    beginTurn('trace-disabled')
    expect(getDebugTranscriptNotes('thread-1')).toEqual([])

    setDebugTranscriptCaptureEnabled(true)
    beginTurn('trace-after')
    expect(getDebugTranscriptNotes('thread-1').map(({ traceId }) => traceId)).toEqual(['trace-after'])
  })
})
