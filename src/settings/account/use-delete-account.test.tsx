/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { HttpClientProvider } from '@/contexts'
import { HttpError } from '@/lib/http'
import { StepUpVerificationError } from '@/lib/step-up'
import { createMockHttpClient } from '@/test-utils/http-client'
import { initialState, reducer, useDeleteAccount } from './use-delete-account'

// Only so `useHttpClient()` resolves — both network seams are stubbed per test.
const wrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)

const requestCodeOk = () => Promise.resolve()
const deleteOk = () => Promise.resolve()

describe('useDeleteAccount reducer', () => {
  it('opens the confirm step from a clean slate', () => {
    expect(reducer({ ...initialState, error: 'stale' }, { type: 'OPEN_CONFIRM' })).toEqual({
      ...initialState,
      status: 'confirming',
    })
  })

  // Cancelling mid-request must not pop the code dialog when the response lands.
  it('ignores CODE_SENT once the user has cancelled', () => {
    const cancelled = { ...initialState, status: 'idle' as const, isBusy: true }
    expect(reducer(cancelled, { type: 'CODE_SENT' })).toBe(cancelled)
  })

  it('advances to code entry while still confirming', () => {
    const confirming = { ...initialState, status: 'confirming' as const, isBusy: true }
    expect(reducer(confirming, { type: 'CODE_SENT' })).toMatchObject({ status: 'stepUp', isBusy: false })
  })

  it('returns to idle when the code request fails', () => {
    const confirming = { ...initialState, status: 'confirming' as const, isBusy: true }
    expect(reducer(confirming, { type: 'REQUEST_FAILED', payload: 'nope' })).toEqual({
      ...initialState,
      error: 'nope',
    })
  })

  it('clears the code when it is rejected, but stays on code entry', () => {
    const entering = { ...initialState, status: 'stepUp' as const, otp: '12345678', isBusy: true }
    expect(reducer(entering, { type: 'CODE_REJECTED', payload: 'bad' })).toMatchObject({
      status: 'stepUp',
      otp: '',
      error: 'bad',
    })
  })

  // The code is burned only on a committed delete, so it is still good.
  it('keeps the code when the delete itself fails', () => {
    const entering = { ...initialState, status: 'stepUp' as const, otp: '12345678', isBusy: true }
    expect(reducer(entering, { type: 'DELETE_FAILED', payload: 'boom' })).toMatchObject({
      status: 'stepUp',
      otp: '12345678',
      error: 'boom',
    })
  })
})

describe('useDeleteAccount', () => {
  afterEach(cleanup)

  it('sends the entered code and finishes exactly once', async () => {
    const receivedOtps: string[] = []
    let deletedCount = 0
    const { result } = renderHook(
      () =>
        useDeleteAccount(
          async (_client, { stepUpOtp }) => {
            receivedOtps.push(stepUpOtp)
          },
          requestCodeOk,
          async () => {
            deletedCount += 1
          },
        ),
      { wrapper },
    )

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    expect(result.current.status).toBe('stepUp')

    act(() => result.current.setOtp('12345678'))
    await act(async () => {
      await result.current.confirmDeletion()
    })

    expect(receivedOtps).toEqual(['12345678'])
    expect(deletedCount).toBe(1)
  })

  it('translates a 429 rather than surfacing the raw HTTP message', async () => {
    const throttled = () => Promise.reject(new HttpError(new Response('{}', { status: 429 })))
    const { result } = renderHook(() => useDeleteAccount(deleteOk, throttled), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.error).toContain('Wait a moment')
    expect(result.current.error).not.toContain('status 429')
  })

  it('clears the input and stays put when the code is rejected', async () => {
    const rejected = () => Promise.reject(new StepUpVerificationError('step_up_invalid'))
    let deletedCount = 0
    const { result } = renderHook(
      () =>
        useDeleteAccount(rejected, requestCodeOk, async () => {
          deletedCount += 1
        }),
      { wrapper },
    )

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    act(() => result.current.setOtp('00000001'))
    await act(async () => {
      await result.current.confirmDeletion()
    })

    expect(result.current.status).toBe('stepUp')
    expect(result.current.otp).toBe('')
    expect(result.current.error).toContain('invalid or expired')
    // The account survived, so the device must not be wiped.
    expect(deletedCount).toBe(0)
  })

  it('does not wipe the device when the delete fails for another reason', async () => {
    const failed = () => Promise.reject(new Error('network down'))
    let deletedCount = 0
    const { result } = renderHook(
      () =>
        useDeleteAccount(failed, requestCodeOk, async () => {
          deletedCount += 1
        }),
      { wrapper },
    )

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    act(() => result.current.setOtp('12345678'))
    await act(async () => {
      await result.current.confirmDeletion()
    })

    expect(result.current.status).toBe('stepUp')
    expect(result.current.otp).toBe('12345678')
    expect(deletedCount).toBe(0)
  })
})
