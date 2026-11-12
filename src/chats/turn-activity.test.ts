/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import type { ThunderboltUIMessage } from '@/types'
import { getTurnActivity } from './turn-activity'

const userMessage: ThunderboltUIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
const emptyAssistant: ThunderboltUIMessage = { id: 'a1', role: 'assistant', parts: [] }
const filledAssistant: ThunderboltUIMessage = {
  id: 'a2',
  role: 'assistant',
  parts: [{ type: 'text', text: 'hello' }],
}

const base = { hasChatError: false, retriesExhausted: false, retryCount: 0, stopRequested: false }

describe('getTurnActivity', () => {
  it('is active while the model is thinking (submitted)', () => {
    const activity = getTurnActivity({ ...base, status: 'submitted', lastMessage: userMessage })
    expect(activity.isGenerating).toBe(true)
    expect(activity.isActive).toBe(true)
    expect(activity.showSubmittedLoading).toBe(true)
  })

  it('is active while streaming', () => {
    const activity = getTurnActivity({ ...base, status: 'streaming', lastMessage: filledAssistant })
    expect(activity.isStreaming).toBe(true)
    expect(activity.isActive).toBe(true)
  })

  // The THU-791 regression: an empty assistant turn sits with status back to
  // `ready` and retryCount 0 while the thread shows a recovery spinner. The Stop
  // button must be present here — this is what the composer missed.
  it('is active during empty-turn recovery even with retryCount 0', () => {
    const activity = getTurnActivity({ ...base, status: 'ready', lastMessage: emptyAssistant })
    expect(activity.pendingEmptyTurnRecovery).toBe(true)
    expect(activity.isActive).toBe(true)
    expect(activity.hasError).toBe(false)
  })

  it.each([
    { parts: [] },
    { parts: [{ type: 'step-start' }] },
    { parts: [{ type: 'text', text: 'Partial answer', state: 'done' }] },
  ] satisfies { parts: ThunderboltUIMessage['parts'] }[])(
    'keeps a restored terminal error visible with parts %j',
    ({ parts }) => {
      const activity = getTurnActivity({
        ...base,
        status: 'ready',
        lastMessage: {
          ...emptyAssistant,
          parts,
          metadata: { turnOutcome: 'error' },
        },
      })
      expect(activity.hasError).toBe(true)
      expect(activity.isActive).toBe(false)
      expect(activity.pendingEmptyTurnRecovery).toBe(false)
    },
  )

  it.each(['completed', 'stopped'] as const)('keeps an explicitly %s empty reply idle', (turnOutcome) => {
    const activity = getTurnActivity({
      ...base,
      status: 'ready',
      lastMessage: {
        ...emptyAssistant,
        parts: [{ type: 'step-start' }],
        metadata: { turnOutcome },
      },
    })
    expect(activity.hasError).toBe(false)
    expect(activity.isActive).toBe(false)
    expect(activity.pendingEmptyTurnRecovery).toBe(false)
  })

  it.each(['submitted', 'streaming'] as const)('hides the saved error while a new request is %s', (status) => {
    const activity = getTurnActivity({
      ...base,
      status,
      lastMessage: {
        ...emptyAssistant,
        metadata: { turnOutcome: 'error' },
      },
    })
    expect(activity.hasError).toBe(false)
    expect(activity.isGenerating).toBe(true)
  })

  it('recognizes legacy stream framing as an empty failed reply after hydration', () => {
    const activity = getTurnActivity({
      ...base,
      status: 'ready',
      retriesExhausted: true,
      lastMessage: { ...emptyAssistant, parts: [{ type: 'step-start' }] },
    })
    expect(activity.hasError).toBe(true)
    expect(activity.isActive).toBe(false)
  })

  it('is active during an auto-retry backoff (retryCount > 0)', () => {
    const activity = getTurnActivity({ ...base, status: 'ready', lastMessage: userMessage, retryCount: 1 })
    expect(activity.isActive).toBe(true)
  })

  it('is not active once retries are exhausted (shows an error instead)', () => {
    const activity = getTurnActivity({
      ...base,
      status: 'ready',
      lastMessage: emptyAssistant,
      retriesExhausted: true,
      retryCount: 3,
    })
    expect(activity.isActive).toBe(false)
    expect(activity.pendingEmptyTurnRecovery).toBe(false)
    expect(activity.hasError).toBe(true)
  })

  it('is not active on a settled chat error', () => {
    const activity = getTurnActivity({ ...base, status: 'ready', lastMessage: userMessage, hasChatError: true })
    expect(activity.isActive).toBe(false)
    expect(activity.hasError).toBe(true)
    expect(activity.pendingEmptyTurnRecovery).toBe(false)
  })

  it('is idle after a normal completed turn', () => {
    const activity = getTurnActivity({ ...base, status: 'ready', lastMessage: filledAssistant })
    expect(activity.isActive).toBe(false)
    expect(activity.showSubmittedLoading).toBe(false)
    expect(activity.hasError).toBe(false)
  })

  it('shows submitted-loading while awaiting a continuation after assistant text', () => {
    const activity = getTurnActivity({ ...base, status: 'submitted', lastMessage: filledAssistant })
    expect(activity.showSubmittedLoading).toBe(true)
    expect(activity.isActive).toBe(true)
  })
})

describe('getTurnActivity stopping', () => {
  it('reports stopping while the aborted request is still unwinding', () => {
    const activity = getTurnActivity({
      ...base,
      status: 'streaming',
      lastMessage: filledAssistant,
      stopRequested: true,
    })
    expect(activity.isStopping).toBe(true)
    expect(activity.isActive).toBe(true)
  })

  it('clears stopping once the request settles, even if the flag lingers', () => {
    const activity = getTurnActivity({
      ...base,
      status: 'ready',
      lastMessage: filledAssistant,
      stopRequested: true,
    })
    expect(activity.isStopping).toBe(false)
  })
})
