/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts/http-client-context'
import { RotationStaleError, StepUpVerificationError } from '@/services/encryption'
import { createMockHttpClient } from '@/test-utils/http-client'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { reducer, initialState, useChangeRecoveryKey } from './use-change-recovery-key'

const newPhrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima'
const requestCodeOk = () => Promise.resolve()

const wrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)

describe('useChangeRecoveryKey reducer', () => {
  it('opens the confirm dialog from idle', () => {
    expect(reducer(initialState, { type: 'OPEN_CONFIRM' }).status).toBe('confirming')
  })

  it('advances to code entry once the code is sent, with a clean input', () => {
    const requesting = { ...initialState, status: 'confirming' as const, isBusy: true, otp: 'stale' }
    const next = reducer(requesting, { type: 'CODE_SENT' })
    expect(next.status).toBe('stepUp')
    expect(next.otp).toBe('')
    expect(next.isBusy).toBe(false)
  })

  it('shows the new phrase on success', () => {
    const next = reducer(initialState, { type: 'ROTATION_SUCCESS', payload: newPhrase })
    expect(next.status).toBe('display')
    expect(next.newRecoveryKey).toBe(newPhrase)
    expect(next.isBusy).toBe(false)
  })

  it('stays on the current dialog on failure so it doubles as retry', () => {
    const rotating = { ...initialState, status: 'stepUp' as const, isBusy: true, otp: '12345678' }
    const next = reducer(rotating, { type: 'ROTATION_FAILED', payload: 'boom' })
    expect(next.status).toBe('stepUp')
    expect(next.error).toBe('boom')
    expect(next.isBusy).toBe(false)
    // A non-step-up failure did not consume the code — keep it for the retry.
    expect(next.otp).toBe('12345678')
  })

  it('clears the code when it was rejected', () => {
    const rotating = { ...initialState, status: 'stepUp' as const, isBusy: true, otp: '12345678' }
    const next = reducer(rotating, { type: 'CODE_REJECTED', payload: 'bad code' })
    expect(next.status).toBe('stepUp')
    expect(next.otp).toBe('')
    expect(next.error).toBe('bad code')
  })
})

describe('useChangeRecoveryKey', () => {
  afterEach(cleanup)

  it('requests the code, then rotates with it and displays the new phrase', async () => {
    const receivedOtps: string[] = []
    const rotate = (_http: unknown, opts: { stepUpOtp: string }) => {
      receivedOtps.push(opts.stepUpOtp)
      return Promise.resolve(newPhrase)
    }
    const { result } = renderHook(() => useChangeRecoveryKey(rotate, requestCodeOk), { wrapper })

    act(() => result.current.openConfirm())
    expect(result.current.status).toBe('confirming')

    await act(async () => {
      await result.current.requestStepUpCode()
    })
    expect(result.current.status).toBe('stepUp')

    act(() => result.current.setOtp('88299917'))
    await act(async () => {
      await result.current.confirmRotation()
    })

    expect(receivedOtps).toEqual(['88299917'])
    expect(result.current.status).toBe('display')
    expect(result.current.newRecoveryKey).toBe(newPhrase)
  })

  it('stays on the confirm dialog when the code request fails', async () => {
    const requestCode = () => Promise.reject(new Error('mail down'))
    const rotate = () => Promise.resolve(newPhrase)
    const { result } = renderHook(() => useChangeRecoveryKey(rotate, requestCode), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })

    expect(result.current.status).toBe('confirming')
    expect(result.current.error).toBe('mail down')
  })

  it('clears the input and stays on code entry when the server rejects the code', async () => {
    const rotate = () => Promise.reject(new StepUpVerificationError('step_up_invalid'))
    const { result } = renderHook(() => useChangeRecoveryKey(rotate, requestCodeOk), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    act(() => result.current.setOtp('00000000'))
    await act(async () => {
      await result.current.confirmRotation()
    })

    expect(result.current.status).toBe('stepUp')
    expect(result.current.otp).toBe('')
    expect(result.current.error).toContain('invalid or expired')
  })

  it('surfaces a retryable message on RotationStaleError and keeps the code', async () => {
    const rotate = () => Promise.reject(new RotationStaleError())
    const { result } = renderHook(() => useChangeRecoveryKey(rotate, requestCodeOk), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    act(() => result.current.setOtp('88299917'))
    await act(async () => {
      await result.current.confirmRotation()
    })

    expect(result.current.error).toContain('try again')
    expect(result.current.status).toBe('stepUp')
    expect(result.current.otp).toBe('88299917')
  })
})
