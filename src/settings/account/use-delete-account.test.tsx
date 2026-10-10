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

  // Resend starts from `stepUp`, not `confirming`. Ignoring it there left
  // `isBusy` stuck on, disabling the input and Cancel for good.
  it('clears the busy flag and the stale code on a resend', () => {
    const resending = { ...initialState, status: 'stepUp' as const, isBusy: true, otp: '12345678' }
    expect(reducer(resending, { type: 'CODE_SENT' })).toMatchObject({ status: 'stepUp', isBusy: false, otp: '' })
  })

  it('returns to idle when the first code request fails', () => {
    const confirming = { ...initialState, status: 'confirming' as const, isBusy: true }
    expect(reducer(confirming, { type: 'REQUEST_FAILED', payload: { message: 'nope', throttled: false } })).toEqual({
      ...initialState,
      error: 'nope',
    })
  })

  // A failed RESEND must not close the dialog: the step-up dialog has its own
  // alert slot, and on a cooldown refusal the previous code is still valid.
  it('keeps the code when a resend is refused by the cooldown', () => {
    const resending = { ...initialState, status: 'stepUp' as const, isBusy: true, otp: '12345678' }
    expect(
      reducer(resending, { type: 'REQUEST_FAILED', payload: { message: 'too soon', throttled: true } }),
    ).toMatchObject({ status: 'stepUp', isBusy: false, otp: '12345678', error: 'too soon' })
  })

  // Any other resend failure happens AFTER the server minted a replacement and
  // destroyed the old code, so what is in the box is already dead — submitting
  // it would just burn one of the three attempts.
  it('clears the dead code when a resend fails for any other reason', () => {
    const resending = { ...initialState, status: 'stepUp' as const, isBusy: true, otp: '12345678' }
    expect(
      reducer(resending, { type: 'REQUEST_FAILED', payload: { message: 'send failed', throttled: false } }),
    ).toMatchObject({ status: 'stepUp', isBusy: false, otp: '', error: 'send failed' })
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

  it('stays usable after a resend', async () => {
    const { result } = renderHook(() => useDeleteAccount(deleteOk, requestCodeOk), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    act(() => result.current.setOtp('11112222'))

    // Resend: the old code is dead, so the input clears — but the dialog must
    // come back out of its busy state.
    await act(async () => {
      await result.current.requestStepUpCode()
    })

    expect(result.current.status).toBe('stepUp')
    expect(result.current.isBusy).toBe(false)
    expect(result.current.otp).toBe('')
  })

  it('drops the dead code when a resend fails outright', async () => {
    let attempt = 0
    const failSecondSend = () => {
      attempt += 1
      return attempt === 1 ? Promise.resolve() : Promise.reject(new HttpError(new Response('{}', { status: 500 })))
    }
    const { result } = renderHook(() => useDeleteAccount(deleteOk, failSecondSend), { wrapper })

    act(() => result.current.openConfirm())
    await act(async () => {
      await result.current.requestStepUpCode()
    })
    act(() => result.current.setOtp('11112222'))

    await act(async () => {
      await result.current.requestStepUpCode()
    })

    // Dialog stays open, but the box is empty: the server destroyed that code
    // when it minted the replacement it then failed to send.
    expect(result.current.status).toBe('stepUp')
    expect(result.current.isBusy).toBe(false)
    expect(result.current.otp).toBe('')
    expect(result.current.error).toContain('may no longer work')
  })

  // The account is already gone at this point; leaving `isBusy` set would
  // disable Cancel, Escape and the backdrop, wedging the dialog for good.
  it('releases the dialog if clearing local data throws', async () => {
    const { result } = renderHook(
      () => useDeleteAccount(deleteOk, requestCodeOk, () => Promise.reject(new Error('indexeddb gone'))),
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

    expect(result.current.isBusy).toBe(false)
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
