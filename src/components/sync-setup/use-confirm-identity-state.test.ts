/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  confirmIdentityReducer,
  initialConfirmIdentityState,
  type ConfirmIdentityAction,
  type ConfirmIdentityState,
} from './use-confirm-identity-state'

const run = (actions: ConfirmIdentityAction[], from: ConfirmIdentityState = initialConfirmIdentityState) =>
  actions.reduce(confirmIdentityReducer, from)

describe('confirmIdentityReducer', () => {
  it('moves to code entry once the code is sent', () => {
    const state = run([{ type: 'CODE_REQUESTED' }, { type: 'CODE_SENT', payload: 'challenge' }])
    expect(state).toEqual({ status: 'sent', otp: '', challengeToken: 'challenge', errorMessage: '' })
  })

  it('stays on the prompt when the first send fails', () => {
    const state = run([{ type: 'CODE_REQUESTED' }, { type: 'CODE_FAILED', payload: 'offline' }])
    expect(state.status).toBe('idle')
    expect(state.errorMessage).toBe('offline')
  })

  it('keeps the code screen when a resend fails', () => {
    const state = run([
      { type: 'CODE_SENT', payload: 'challenge' },
      { type: 'CODE_FAILED', payload: 'offline' },
    ])
    expect(state.status).toBe('sent')
    expect(state.challengeToken).toBe('challenge')
  })

  it('clears the code and shows the error on a wrong code', () => {
    const state = run([
      { type: 'CODE_SENT', payload: 'challenge' },
      { type: 'OTP_CHANGED', payload: '12345678' },
      { type: 'VERIFY_STARTED' },
      { type: 'VERIFY_FAILED', payload: 'wrong code' },
    ])
    expect(state).toEqual({ status: 'sent', otp: '', challengeToken: 'challenge', errorMessage: 'wrong code' })
  })

  it('goes back to the prompt on cancel', () => {
    const state = run([{ type: 'CODE_SENT', payload: 'challenge' }, { type: 'CANCELLED' }])
    expect(state).toEqual(initialConfirmIdentityState)
  })
})
