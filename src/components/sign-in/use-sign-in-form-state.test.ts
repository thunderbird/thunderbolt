/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as passkeys from '@/lib/passkey'
import * as onboarding from '@/lib/returning-user-onboarding'
import * as promotionAnalytics from '@/lib/analytics/use-anonymous-promotion-analytics'
import { eq } from 'drizzle-orm'
import type { FormEvent } from 'react'
import type { HttpClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { useSignInFormState } from './use-sign-in-form-state'

const challengeToken = 'test-challenge-token'
const waitlistResponse = { success: true, challengeToken }

describe('sign-in operation outcomes', () => {
  const mount = (authClient = createMockAuthClient()) => {
    const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
    return renderHook(() => useSignInFormState({ authClient, httpClient, initialEmail: 'test@example.com' }))
  }

  it.each([
    [new DOMException('cancelled', 'NotAllowedError'), 'idle'],
    [new Error('unavailable'), 'error'],
  ] as const)('settles a rejected passkey ceremony: %s', async (error, status) => {
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockRejectedValueOnce(error)
    try {
      const { result } = mount()
      await act(async () => result.current.actions.handlePasskeySignIn())
      expect(result.current.state.status).toBe(status)
      expect(result.current.state.passkeyPending).toBe(false)
      expect(result.current.state.errorMessage).toBe(
        status === 'idle' ? '' : "Couldn't sign in with your passkey. Please try again or use your email.",
      )
    } finally {
      signIn.mockRestore()
    }
  })

  it('announces a successful passkey sign-in', async () => {
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockResolvedValueOnce({ userId: 'user' })
    try {
      const { result } = mount()
      await act(async () => result.current.actions.handlePasskeySignIn())
      expect(result.current.state.status).toBe('success')
      expect(result.current.state.passkeyPending).toBe(false)
    } finally {
      signIn.mockRestore()
    }
  })

  it('excludes overlapping OTP and passkey operations and ignores a cancelled ceremony', async () => {
    const response = Promise.withResolvers<{ userId: string }>()
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementationOnce(() => response.promise)
    const otp = mock(async () => ({ error: null }))
    try {
      const { result } = mount(createMockAuthClient({ signInEmailOtp: otp }))
      let pending: Promise<void>
      await act(async () => {
        pending = result.current.actions.handlePasskeySignIn()
      })
      expect(result.current.state.passkeyPending).toBe(true)
      await act(async () => {
        await result.current.actions.handlePasskeySignIn()
        await result.current.actions.handleOtpComplete('12345678')
      })
      expect(signIn).toHaveBeenCalledTimes(1)
      expect(otp).not.toHaveBeenCalled()
      act(() => result.current.actions.handleCancel())
      await act(async () => {
        response.resolve({ userId: 'late' })
        await pending
      })
      expect(result.current.state.status).toBe('idle')
    } finally {
      signIn.mockRestore()
    }
  })

  it.each(['reported', 'thrown'] as const)('returns to code entry after a %s verification error', async (failure) => {
    const authClient = createMockAuthClient({
      signInEmailOtp: async () => {
        if (failure === 'thrown') {
          throw new Error('offline')
        }
        return { error: { message: 'Invalid code', code: 'INVALID_OTP' } }
      },
    })
    const { result } = mount(authClient)
    await act(async () => result.current.actions.handleOtpComplete('12345678'))
    expect(result.current.state.status).toBe('sent')
    expect(result.current.state.otp).toBe('')
    expect(result.current.state.errorMessage).not.toBe('')
  })

  it('does not verify an incomplete code or a cancelled analytics preflight', async () => {
    const session = Promise.withResolvers<{ data: null; error: null }>()
    const otp = mock(async () => ({ error: null }))
    const { result } = mount(createMockAuthClient({ getSession: () => session.promise, signInEmailOtp: otp }))
    await act(async () => result.current.actions.handleOtpComplete('12'))
    expect(result.current.state.status).toBe('idle')
    let pending: Promise<void>
    act(() => {
      pending = result.current.actions.handleOtpComplete('12345678')
    })
    act(() => result.current.actions.goBack())
    await act(async () => {
      session.resolve({ data: null, error: null })
      await pending
    })
    expect(otp).not.toHaveBeenCalled()
    expect(result.current.state.status).toBe('idle')
  })
})

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
    it('clears a completed code while resending, then accepts re-entry after a failed resend', async () => {
      const resend = Promise.withResolvers<Response>()
      const { httpClient } = createSpyHttpClient(
        mock()
          .mockResolvedValueOnce(jsonResponse(waitlistResponse))
          .mockImplementationOnce(() => resend.promise),
      )
      const verify = mock(async () => ({ error: { code: 'INVALID_OTP', message: 'Invalid code' } }))
      authClient = createMockAuthClient({ signInEmailOtp: verify })
      const { result } = renderFormHook(httpClient)
      await submitEmail(result)
      act(() => result.current.actions.setOtp('12345678'))
      let pending!: Promise<boolean>
      act(() => {
        pending = result.current.actions.handleResend()
        void result.current.actions.handleOtpComplete('12345678')
      })
      expect(result.current.state.status).toBe('resending')
      expect(result.current.state.otp).toBe('')
      expect(verify).not.toHaveBeenCalled()
      await act(async () => {
        resend.resolve(jsonResponse({ message: 'Try again later' }, 429))
        expect(await pending).toBe(false)
      })
      expect(result.current.state.status).toBe('sent')
      expect(result.current.state.challengeToken).toBe(challengeToken)
      await act(async () => result.current.actions.handleOtpComplete('12345678'))
      expect(verify).toHaveBeenCalledTimes(1)
    })

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

  it('sends the issued challenge token when verifying the code', async () => {
    const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
    const emailOtp = mock(async (_options: { email: string; otp: string }) => ({ error: null }))
    authClient = createMockAuthClient({ signInEmailOtp: emailOtp })
    const { result } = renderFormHook(httpClient)
    await submitEmail(result)
    await act(async () => result.current.actions.handleOtpComplete('12345678'))
    expect(emailOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
        otp: '12345678',
        fetchOptions: expect.objectContaining({
          headers: expect.objectContaining({ 'x-challenge-token': challengeToken }),
          signal: expect.any(AbortSignal),
        }),
      }),
    )
    expect(result.current.state.status).toBe('success')
  })

  /**
   * GH #1299: a sign-in path that forgets to mark a returning account as
   * onboarded makes the user redo onboarding and then uploads that `false` over
   * the real value on every other device. Each path needs its own assertion —
   * unit-testing the helper alone is what let the magic link go unwired.
   */
  describe('returning-user onboarding', () => {
    const readOnboarding = async (): Promise<string | null> => {
      const rows = await getDb()
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.key, 'user_has_completed_onboarding'))
      return (rows[0] as { value: string | null } | undefined)?.value ?? null
    }

    const verifyAs = async (user: { id: string; isNew?: boolean }) => {
      const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
      authClient = createMockAuthClient({
        signInEmailOtp: mock(async () => ({ data: { user }, error: null })),
      })
      const { result } = renderHook(() =>
        useSignInFormState({ authClient, httpClient, initialEmail: 'test@example.com' }),
      )

      await act(async () => {
        await result.current.actions.handleOtpComplete('12345678')
      })
    }

    beforeAll(async () => {
      await setupTestDatabase()
    })

    afterAll(async () => {
      await teardownTestDatabase()
    })

    beforeEach(async () => {
      await resetTestDatabase()
      // Seeds `user_has_completed_onboarding = 'false'`, as a fresh device does
      // at boot before it has ever seen the account.
      await reconcileDefaults(getDb())
    })

    it('marks onboarding complete for an account that already existed', async () => {
      await verifyAs({ id: 'u1', isNew: false })

      expect(await readOnboarding()).toBe('true')
    })

    it('leaves onboarding pending for a brand-new account', async () => {
      await verifyAs({ id: 'u1', isNew: true })

      expect(await readOnboarding()).toBe('false')
    })
  })
})

describe('sign-in attempt lifetime', () => {
  it.each([new DOMException('cancelled', 'AbortError'), new Error('late send failure')])(
    'logs only unexpected send failures after unmount: %p',
    async (error) => {
      const response = Promise.withResolvers<Response>()
      const { httpClient } = createSpyHttpClient(() => response.promise)
      const log = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { result, unmount } = renderHook(() =>
          useSignInFormState({
            authClient: createMockAuthClient(),
            httpClient,
            initialEmail: 'test@example.com',
          }),
        )
        let pending!: Promise<void>
        await act(async () => {
          pending = result.current.actions.handleSubmit({ preventDefault() {} } as FormEvent)
        })
        unmount()
        response.reject(error)
        await pending
        if (error.name === 'AbortError') {
          expect(log).not.toHaveBeenCalled()
        } else {
          expect(log).toHaveBeenCalledWith('Failed to send verification OTP:', error)
        }
      } finally {
        log.mockRestore()
      }
    },
  )

  it.each([
    ['otp', 'retry'],
    ['otp', 'back'],
    ['otp', 'cancel'],
    ['passkey', 'retry'],
    ['passkey', 'back'],
    ['passkey', 'cancel'],
  ] as const)('allows %s %s after a committed failure', async (method, action) => {
    const failure =
      method === 'passkey'
        ? new DOMException('Auth session changed while finishing passkey sign-in', 'AbortError')
        : new Error('Promotion analytics failed')
    const onPromotionSuccess = mock(() => {})
    if (method === 'otp') {
      onPromotionSuccess.mockImplementationOnce(() => {
        throw failure
      })
    }
    const analytics = spyOn(promotionAnalytics, 'useAnonymousPromotionAnalytics').mockReturnValue({
      captureAnonId: async () => {},
      persistForSso: () => {},
      onPromotionSuccess,
    })
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation(async (_client, options) => {
      options?.onAuthenticated?.()
      return { userId: 'user' }
    })
    signIn.mockImplementationOnce(async (_client, options) => {
      options?.onAuthenticated?.()
      throw failure
    })
    const markOnboarded = spyOn(onboarding, 'markOnboardedForReturningUser').mockResolvedValue()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    const onCancel = mock(() => {})
    const otp = mock(async () => ({ data: { user: { id: 'user', isNew: true } }, error: null }))
    const { httpClient } = createSpyHttpClient(undefined, { success: true, challengeToken: 'fresh-challenge' })
    try {
      const { result } = renderHook(() =>
        useSignInFormState({
          authClient: createMockAuthClient({ signInEmailOtp: otp }),
          httpClient,
          initialEmail: 'test@example.com',
          onCancel,
        }),
      )
      const run = () =>
        method === 'otp'
          ? result.current.actions.handleOtpComplete('12345678')
          : result.current.actions.handlePasskeySignIn()
      await act(run)
      expect(result.current.state.status).toBe(method === 'otp' ? 'sent' : 'error')
      expect(result.current.state.errorMessage).not.toBe('')
      expect(log).toHaveBeenCalledWith(method === 'otp' ? 'OTP verification error:' : 'Passkey sign-in error:', failure)
      if (action === 'retry') {
        if (method === 'otp') {
          await act(async () => expect(await result.current.actions.handleResend()).toBe(true))
          await act(() => result.current.actions.handleOtpComplete('87654321'))
          expect(otp).toHaveBeenLastCalledWith(
            expect.objectContaining({
              otp: '87654321',
              fetchOptions: expect.objectContaining({
                headers: expect.objectContaining({ 'x-challenge-token': 'fresh-challenge' }),
              }),
            }),
          )
        } else {
          await act(run)
        }
        expect(method === 'otp' ? otp : signIn).toHaveBeenCalledTimes(2)
        expect(result.current.state.status).toBe('success')
        act(() => result.current.actions.handleCancel())
        expect(onCancel).not.toHaveBeenCalled()
      } else if (action === 'back') {
        act(() => expect(result.current.actions.goBack()).toBe(true))
        expect(result.current.state.status).toBe('idle')
      } else {
        act(() => result.current.actions.handleCancel())
        expect(onCancel).toHaveBeenCalledTimes(1)
        expect(result.current.state.status).toBe('idle')
      }
    } finally {
      log.mockRestore()
      markOnboarded.mockRestore()
      signIn.mockRestore()
      analytics.mockRestore()
    }
  })

  it.each([
    { committed: true, error: new Error('postcommit failure'), logged: true },
    { committed: true, error: new DOMException('account changed', 'AbortError'), logged: true },
    { committed: true, error: new DOMException('unexpected after commit', 'NotAllowedError'), logged: true },
    { committed: false, error: new DOMException('cancelled', 'AbortError'), logged: false },
    { committed: false, error: new DOMException('dismissed', 'NotAllowedError'), logged: false },
    { committed: false, error: new Error('unexpected late failure'), logged: true },
  ])('handles an unmounted passkey failure: %j', async ({ committed, error, logged }) => {
    const response = Promise.withResolvers<{ userId: string }>()
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation((_client, options) => {
      if (committed) {
        options?.onAuthenticated?.()
      }
      return response.promise
    })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
    try {
      const { result, unmount } = renderHook(() =>
        useSignInFormState({ authClient: createMockAuthClient(), httpClient }),
      )
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.actions.handlePasskeySignIn()
      })
      expect(signIn).toHaveBeenCalledTimes(1)
      unmount()
      response.reject(error)
      await pending
      if (logged) {
        expect(log).toHaveBeenCalledWith('Passkey sign-in error:', error)
      } else {
        expect(log).not.toHaveBeenCalled()
      }
    } finally {
      log.mockRestore()
      signIn.mockRestore()
    }
  })

  it('logs an unexpected OTP completion exception after unmount', async () => {
    const completion = Promise.withResolvers<void>()
    const failure = new Error('Unexpected completion exception')
    // Housekeeping normally handles its own errors. Keep the outer boundary
    // observable if a future implementation throws unexpectedly after commit.
    const markOnboarded = spyOn(onboarding, 'markOnboardedForReturningUser').mockReturnValue(completion.promise)
    const log = spyOn(console, 'error').mockImplementation(() => {})
    const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
    try {
      const { result, unmount } = renderHook(() =>
        useSignInFormState({ authClient: createMockAuthClient(), httpClient }),
      )
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.actions.handleOtpComplete('12345678')
      })
      expect(result.current.state.status).toBe('completing')
      unmount()
      completion.reject(failure)
      await pending
      expect(log).toHaveBeenCalledWith('OTP verification error:', failure)
    } finally {
      log.mockRestore()
      markOnboarded.mockRestore()
    }
  })

  it('refuses Cancel and Back after credentials commit, and finishes housekeeping after unmount', async () => {
    const housekeeping = Promise.withResolvers<void>()
    const markOnboarded = spyOn(onboarding, 'markOnboardedForReturningUser').mockReturnValue(housekeeping.promise)
    const onCancel = mock(() => {})
    const { httpClient } = createSpyHttpClient(undefined, waitlistResponse)
    const { result, unmount } = renderHook(() =>
      useSignInFormState({
        authClient: createMockAuthClient({ signInEmailOtp: async () => ({ error: null }) }),
        httpClient,
        initialEmail: 'test@example.com',
        onCancel,
      }),
    )
    try {
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.actions.handleOtpComplete('12345678')
      })
      expect(result.current.state.status).toBe('completing')
      act(() => {
        result.current.actions.handleCancel()
        expect(result.current.actions.goBack()).toBe(false)
      })
      expect(result.current.state.status).toBe('completing')
      expect(onCancel).not.toHaveBeenCalled()
      unmount()
      housekeeping.resolve()
      await pending
      expect(markOnboarded).toHaveBeenCalledTimes(1)
    } finally {
      markOnboarded.mockRestore()
    }
  })

  it.each(['back', 'cancel', 'unmount'] as const)('ignores a code response after %s', async (action) => {
    const response = Promise.withResolvers<Response>()
    const { httpClient } = createSpyHttpClient(() => response.promise)
    const onEmailSent = mock(() => {})
    const { result, unmount } = renderHook(() =>
      useSignInFormState({
        authClient: createMockAuthClient(),
        httpClient,
        initialEmail: 'test@example.com',
        onEmailSent,
      }),
    )
    const pending: Promise<void>[] = []
    act(() => {
      pending.push(result.current.actions.handleSubmit({ preventDefault() {} } as FormEvent))
    })
    act(() => {
      if (action === 'back') {
        result.current.actions.goBack()
      } else if (action === 'cancel') {
        result.current.actions.handleCancel()
      } else {
        unmount()
      }
    })
    await act(async () => {
      response.resolve(jsonResponse(waitlistResponse))
      await pending[0]
    })
    expect(onEmailSent).not.toHaveBeenCalled()
    if (action !== 'unmount') {
      expect(result.current.state.status).toBe('idle')
    }
  })

  it('does not start duplicate sends from the same render', async () => {
    const response = Promise.withResolvers<Response>()
    const send = mock(() => response.promise)
    const { httpClient } = createSpyHttpClient(send)
    const { result } = renderHook(() =>
      useSignInFormState({ authClient: createMockAuthClient(), httpClient, initialEmail: 'test@example.com' }),
    )
    const pending: Promise<void>[] = []
    act(() => {
      pending.push(result.current.actions.handleSubmit({ preventDefault() {} } as FormEvent))
      pending.push(result.current.actions.handleSubmit({ preventDefault() {} } as FormEvent))
    })
    await act(async () => {
      response.resolve(jsonResponse(waitlistResponse))
      await Promise.all(pending)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.state.status).toBe('sent')
  })
})
