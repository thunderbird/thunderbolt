/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { FormEvent } from 'react'
import type { HttpClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { useSignInFormState } from './use-sign-in-form-state'

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

      // Asserted per-key rather than as a whole object: the per-call headers must
      // also re-include the client-level ones (X-App-Version above all), because
      // Better Auth replaces them instead of merging and the gate is fail-closed.
      // `mock(async () => …)` declares no parameters, so `calls` is typed as an
      // empty tuple — widen before indexing.
      const [call] = emailOtpSpy.mock.calls[0] as unknown as [
        { email: string; otp: string; fetchOptions: { headers: Record<string, string> } },
      ]
      expect(call.email).toBe('test@example.com')
      expect(call.otp).toBe('12345678')
      expect(call.fetchOptions.headers['x-challenge-token']).toBe('pre-existing-token')
      expect(call.fetchOptions.headers).toHaveProperty('X-Client-Platform')
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
        useSignInFormState({ authClient, httpClient, initialEmail: 'test@example.com', skipToOtp: true }),
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
