/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient } from '@/test-utils/http-client-spy'
import {
  confirmIdentityReducer,
  useConfirmIdentityState,
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

describe('confirmation attempt ownership', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('sends and resends challenges for the authenticated account, then confirms once', async () => {
    const otp = mock(async () => ({ error: null }))
    const onConfirmed = mock()
    const authClient = createMockAuthClient({
      session: { user: { id: 'user', email: 'account@example.com' } },
      signInEmailOtp: otp,
    })
    const { httpClient, fetchSpy } = createSpyHttpClient(undefined, { challengeToken: 'challenge' })
    const { result } = renderHook(() => useConfirmIdentityState({ onConfirmed }), {
      wrapper: createTestProvider({ authClient, httpClient }),
    })
    await act(async () => expect(await result.current.actions.sendCode()).toBe(true))
    expect(result.current.email).toBe('account@example.com')
    expect(result.current.state.challengeToken).toBe('challenge')
    const codeRequest = fetchSpy.mock.calls
      .map(([request]) => request as Request)
      .find((request) => request.url.endsWith('/waitlist/join'))!
    expect(await codeRequest.json()).toEqual({ email: 'account@example.com' })
    await act(async () => expect(await result.current.actions.resend()).toBe(true))
    await act(async () => result.current.actions.verify('12'))
    expect(otp).not.toHaveBeenCalled()
    await act(async () => result.current.actions.verify('12345678'))
    expect(otp).toHaveBeenCalledTimes(1)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('settles request and verification failures without confirming', async () => {
    const onConfirmed = mock()
    const { httpClient } = createSpyHttpClient(async () => {
      throw new Error('offline')
    })
    const authClient = createMockAuthClient({ signInEmailOtp: async () => ({ error: { message: 'Wrong code' } }) })
    const { result } = renderHook(() => useConfirmIdentityState({ onConfirmed }), {
      wrapper: createTestProvider({ authClient, httpClient }),
    })
    await act(async () => expect(await result.current.actions.sendCode()).toBe(false))
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.errorMessage).toContain('Failed to send')
    await act(async () => result.current.actions.verify('12345678'))
    expect(result.current.state.status).toBe('sent')
    expect(result.current.state.errorMessage).not.toBe('')
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it('does not reopen code entry after cancellation', async () => {
    const response = Promise.withResolvers<Response>()
    const { httpClient } = createSpyHttpClient(() => response.promise)
    const { result } = renderHook(() => useConfirmIdentityState({ onConfirmed: mock() }), {
      wrapper: createTestProvider({ httpClient }),
    })
    let pending: Promise<boolean>
    act(() => {
      pending = result.current.actions.sendCode()
    })
    act(() => result.current.actions.cancel())
    await act(async () => {
      response.resolve(Response.json({ challengeToken: 'late' }))
      await pending
    })
    expect(result.current.state).toEqual(initialConfirmIdentityState)
  })

  it('does not confirm a cancelled verification', async () => {
    const response = Promise.withResolvers<{ error: null }>()
    const onConfirmed = mock()
    const authClient = createMockAuthClient({ signInEmailOtp: () => response.promise })
    const { result } = renderHook(() => useConfirmIdentityState({ onConfirmed }), {
      wrapper: createTestProvider({ authClient }),
    })
    let pending: Promise<void>
    act(() => {
      pending = result.current.actions.verify('12345678')
    })
    act(() => result.current.actions.cancel())
    await act(async () => {
      response.resolve({ error: null })
      await pending
    })
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(result.current.state).toEqual(initialConfirmIdentityState)
  })
})
