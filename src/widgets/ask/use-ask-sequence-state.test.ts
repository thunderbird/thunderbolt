/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { sequenceReducer } from './use-ask-sequence-state'

const initial = {
  step: 0,
  reviewOpen: false,
  sendStatus: 'idle' as const,
  navigated: false,
  navigatedAt: null,
  answeredStep: null,
}

describe('sequenceReducer', () => {
  test('a submit that finishes the message starts sending its turn, without claiming it was sent', () => {
    const state = sequenceReducer(initial, { type: 'SUBMITTED', advance: false, finish: 'sending', at: 1000 })
    expect(state).toMatchObject({ sendStatus: 'sending', step: 0 })
  })

  test('an intermediate submit sends nothing and may advance, remembering the step it answered', () => {
    expect(sequenceReducer(initial, { type: 'SUBMITTED', advance: true, finish: null, at: 1000 })).toMatchObject({
      sendStatus: 'idle',
      step: 1,
      navigated: true,
      answeredStep: 0,
    })
  })

  test('a graded submit stays on its step, which counts as answered for the step control', () => {
    expect(sequenceReducer(initial, { type: 'SUBMITTED', advance: false, finish: null, at: 1000 })).toMatchObject({
      step: 0,
      answeredStep: 0,
    })
  })

  test('a finish with an "Other…" answer hands off instead of sending', () => {
    expect(
      sequenceReducer(initial, { type: 'SUBMITTED', advance: false, finish: 'handed-off', at: 1000 }).sendStatus,
    ).toBe('handed-off')
    expect(sequenceReducer({ ...initial, sendStatus: 'failed' }, { type: 'HANDED_OFF' }).sendStatus).toBe('handed-off')
  })

  test('a failed send can be retried; success marks it sent', () => {
    const sending = sequenceReducer(initial, { type: 'SUBMITTED', advance: false, finish: 'sending', at: 1000 })
    const failed = sequenceReducer(sending, { type: 'SEND_FAILED' })
    expect(failed.sendStatus).toBe('failed')

    const retried = sequenceReducer(failed, { type: 'SEND_RETRIED' })
    expect(retried.sendStatus).toBe('sending')
    expect(sequenceReducer(retried, { type: 'SEND_SUCCEEDED' }).sendStatus).toBe('sent')
  })

  test('the step control moves to the given step and marks it navigated', () => {
    expect(sequenceReducer({ ...initial, step: 2 }, { type: 'STEP_CHANGED', step: 1, at: 1000 })).toMatchObject({
      step: 1,
      navigated: true,
    })
  })

  test('a request that failed inside the chat gets its own status, which the widget shows nothing for', () => {
    const sending = sequenceReducer(initial, { type: 'SUBMITTED', advance: false, finish: 'sending', at: 1000 })
    expect(sequenceReducer(sending, { type: 'SEND_FAILED_IN_CHAT' }).sendStatus).toBe('failed-in-chat')
  })
})
