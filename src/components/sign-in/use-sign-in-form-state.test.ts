/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { FormEvent } from 'react'
import type { HttpClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { onSignInSuccess, useSignInFormState } from './use-sign-in-form-state'

const challengeToken = 'test-challenge-token'
const waitlistResponse = { success: true, challengeToken }

describe('useSignInFormState', () => {
  let authClient: ReturnType<typeof createMockAuthClient>

  beforeEach(() => {
    authClient = createMockAuthClient()
  })

  const renderFormHook = (httpClient: HttpClient) =>
    renderHook(() =>
      useSignInFormState({
        authClient,
        httpClient,
      }),
    )

  /** Helper: submit email to move the form into 'sent' status so resend is available. */
  const submitEmail = async (result: { current: ReturnType<typeof useSignInFormState> }) => {
    act(() => {
      result.current.actions.setEmail('test@example.com')
    })
    await act(async () => {
      await result.current.actions.handleSubmit({ preventDefault: () => {} } as FormEvent)
    })
    expect(result.current.state.status).toBe('sent')
  }

  describe('handleSubmit cooldown error', () => {
    it('surfaces the server cooldown message on 429', async () => {
      const cooldownMessage = 'A verification code was recently sent. Please wait before requesting a new one.'
      let callCount = 0
      const { httpClient } = createSpyHttpClient(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse(waitlistResponse)
        }
        return jsonResponse({ error: 'code_already_sent', message: cooldownMessage }, 429)
      })

      const { result } = renderFormHook(httpClient)

      // First submit succeeds
      await submitEmail(result)

      // Go back and resubmit — hits cooldown
      act(() => {
        result.current.actions.goBack()
      })
      await act(async () => {
        await result.current.actions.handleSubmit({ preventDefault: () => {} } as FormEvent)
      })

      expect(result.current.state.status).toBe('error')
      expect(result.current.state.errorMessage).toBe(cooldownMessage)
    })

    it('shows generic error for network failures', async () => {
      const { httpClient } = createSpyHttpClient(async () => {
        throw new TypeError('Failed to fetch')
      })

      const { result } = renderFormHook(httpClient)

      act(() => {
        result.current.actions.setEmail('test@example.com')
      })
      await act(async () => {
        await result.current.actions.handleSubmit({ preventDefault: () => {} } as FormEvent)
      })

      expect(result.current.state.status).toBe('error')
      expect(result.current.state.errorMessage).toBe('Failed to send verification code. Please check your connection.')
    })
  })

  describe('handleResend cooldown error', () => {
    it('surfaces the server cooldown message on 429', async () => {
      const cooldownMessage = 'A verification code was recently sent. Please wait before requesting a new one.'
      let callCount = 0
      const { httpClient } = createSpyHttpClient(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse(waitlistResponse)
        }
        return jsonResponse({ error: 'code_already_sent', message: cooldownMessage }, 429)
      })

      const { result } = renderFormHook(httpClient)

      // First submit succeeds, moving to 'sent' state
      await submitEmail(result)

      // Resend hits cooldown
      let resendResult: boolean | undefined
      await act(async () => {
        resendResult = await result.current.actions.handleResend()
      })

      expect(resendResult).toBe(false)
      expect(result.current.state.errorMessage).toBe(cooldownMessage)
    })

    it('shows generic error for network failures', async () => {
      let callCount = 0
      const { httpClient } = createSpyHttpClient(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse(waitlistResponse)
        }
        throw new TypeError('Failed to fetch')
      })

      const { result } = renderFormHook(httpClient)

      await submitEmail(result)

      await act(async () => {
        await result.current.actions.handleResend()
      })

      expect(result.current.state.errorMessage).toBe(
        'Failed to resend verification code. Please check your connection.',
      )
    })

    it('surfaces a non-cooldown server error message', async () => {
      let callCount = 0
      const { httpClient } = createSpyHttpClient(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse(waitlistResponse)
        }
        return jsonResponse({ error: 'internal_error', message: 'Something broke' }, 500)
      })

      const { result } = renderFormHook(httpClient)

      await submitEmail(result)

      await act(async () => {
        await result.current.actions.handleResend()
      })

      expect(result.current.state.errorMessage).toBe('Something broke')
    })
  })

  describe('skipToOtp with initialChallengeToken', () => {
    it('initializes with challengeToken when skipToOtp is true', () => {
      const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
      const { result } = renderHook(() =>
        useSignInFormState({
          authClient,
          httpClient,
          initialEmail: 'test@example.com',
          skipToOtp: true,
          initialChallengeToken: 'pre-existing-token',
        }),
      )

      expect(result.current.state.status).toBe('sent')
      expect(result.current.state.challengeToken).toBe('pre-existing-token')
    })

    it('sends challengeToken in OTP verification when skipToOtp is used', async () => {
      const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
      const emailOtpSpy = mock(async () => ({ data: { user: { id: '1' } }, error: null }))
      authClient = createMockAuthClient({ signInEmailOtp: emailOtpSpy })

      const { result } = renderHook(() =>
        useSignInFormState({
          authClient,
          httpClient,
          initialEmail: 'test@example.com',
          skipToOtp: true,
          initialChallengeToken: 'pre-existing-token',
        }),
      )

      await act(async () => {
        await result.current.actions.handleOtpComplete('12345678')
      })

      expect(emailOtpSpy).toHaveBeenCalledWith({
        email: 'test@example.com',
        otp: '12345678',
        fetchOptions: {
          headers: { 'x-challenge-token': 'pre-existing-token' },
        },
      })
    })

    it('defaults challengeToken to empty string without initialChallengeToken', () => {
      const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
      const { result } = renderHook(() =>
        useSignInFormState({
          authClient,
          httpClient,
          initialEmail: 'test@example.com',
          skipToOtp: true,
        }),
      )

      expect(result.current.state.status).toBe('sent')
      expect(result.current.state.challengeToken).toBe('')
    })
  })
})

describe('onSignInSuccess', () => {
  type Deps = NonNullable<Parameters<typeof onSignInSuccess>[2]>

  const buildDeps = () => {
    const clearPendingCrudOperations = mock(async () => {})
    const getDatabase = mock(() => ({ clearPendingCrudOperations })) as unknown as NonNullable<Deps['getDatabase']>
    // updateSettings(db, ...) calls db.transaction(cb) and the callback chains drizzle builders
    // like `tx.insert(table).values(row)`. Build a self-referential Proxy that is also a thenable,
    // so any chained property access or call resolves cleanly.
    const txStub: unknown = new Proxy(function () {}, {
      get: (_target, prop) => {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(undefined)
        }
        return txStub
      },
      apply: () => txStub,
    })
    const drizzle = {
      transaction: mock(async (cb: (tx: unknown) => Promise<void>) => {
        await cb(txStub)
      }),
    }
    const getDrizzle = mock(() => drizzle) as unknown as NonNullable<Deps['getDrizzle']>
    return { clearPendingCrudOperations, getDatabase, getDrizzle }
  }

  it('does not clear the CRUD queue when promoting an anonymous session (wasAnonymous=true)', async () => {
    const { clearPendingCrudOperations, getDatabase, getDrizzle } = buildDeps()

    await onSignInSuccess(false, true, { getDatabase, getDrizzle })

    expect(getDatabase).not.toHaveBeenCalled()
    expect(getDrizzle).not.toHaveBeenCalled()
    expect(clearPendingCrudOperations).not.toHaveBeenCalled()
  })

  it('does not clear the CRUD queue for a new user signup (isNewUser=true)', async () => {
    const { clearPendingCrudOperations, getDatabase, getDrizzle } = buildDeps()

    await onSignInSuccess(true, false, { getDatabase, getDrizzle })

    expect(getDatabase).not.toHaveBeenCalled()
    expect(getDrizzle).not.toHaveBeenCalled()
    expect(clearPendingCrudOperations).not.toHaveBeenCalled()
  })

  it('clears the CRUD queue for a returning non-anonymous user (isNewUser=false, wasAnonymous=false)', async () => {
    const { clearPendingCrudOperations, getDatabase, getDrizzle } = buildDeps()

    await onSignInSuccess(false, false, { getDatabase, getDrizzle })

    expect(getDatabase).toHaveBeenCalledTimes(1)
    expect(clearPendingCrudOperations).toHaveBeenCalledTimes(1)
  })
})
