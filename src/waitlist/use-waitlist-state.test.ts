/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as passkeys from '@/lib/passkey'
import * as returningUserOnboarding from '@/lib/returning-user-onboarding'
import { buildFetchOptions, type AuthClient } from '@/contexts/auth-context'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { useWelcomeStore } from '@/components/welcome-dialog'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { useWaitlistState } from './use-waitlist-state'
import type { FormEvent } from 'react'
import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { createAuthClient } from 'better-auth/react'
import { emailOTPClient } from 'better-auth/client/plugins'
import { clearAuthToken, getAuthToken } from '@/lib/auth-token'

/**
 * GH #1299: a sign-in path that forgets to mark a returning account as
 * onboarded makes the user redo onboarding and then uploads that `false` over
 * the real value on every other device. Each path needs its own assertion —
 * unit-testing the helper alone is what let the magic link go unwired.
 */
describe('useWaitlistState — returning-user onboarding', () => {
  const readOnboarding = async (): Promise<string | null> => {
    const rows = await getDb()
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, 'user_has_completed_onboarding'))
    return (rows[0] as { value: string | null } | undefined)?.value ?? null
  }

  const verifyAs = async (user: { id: string; isNew?: boolean }) => {
    const authClient = createMockAuthClient({
      signInEmailOtp: mock(async () => ({ data: { user }, error: null })),
    })
    const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })

    act(() => {
      result.current.actions.setEmail('test@example.com')
    })
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
    // Seeds `user_has_completed_onboarding = 'false'`, as a fresh device does at
    // boot before it has ever seen the account.
    await reconcileDefaults(getDb())
  })

  afterEach(() => {
    // A returning sign-in arms the welcome dialog, and that store is a module
    // singleton shared across every suite in the worker. Drain it so a
    // randomized run cannot leak `pending: true` into `welcome-dialog.test.ts`.
    useWelcomeStore.setState({ pending: false })
    clearAuthToken()
  })

  it('marks onboarding complete for an account that already existed', async () => {
    await verifyAs({ id: 'u1', isNew: false })

    expect(await readOnboarding()).toBe('true')
  })

  it('leaves onboarding pending for a brand-new account', async () => {
    await verifyAs({ id: 'u1', isNew: true })

    expect(await readOnboarding()).toBe('false')
  })
  it('admits one OTP submission before analytics finishes and blocks a concurrent passkey attempt', async () => {
    const session = Promise.withResolvers<{ data: null; error: null }>()
    const signIn = mock(async () => ({ data: { user: { id: 'u1', isNew: true } }, error: null }))
    const authClient = createMockAuthClient({ getSession: () => session.promise, signInEmailOtp: signIn })
    const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
    act(() => result.current.actions.setEmail('test@example.com'))
    const runs: Promise<void>[] = []
    act(() => {
      runs.push(result.current.actions.handleOtpComplete('12345678'))
      runs.push(result.current.actions.handleOtpComplete('12345678'))
      runs.push(result.current.actions.handlePasskeySignIn())
    })
    expect(result.current.state.status).toBe('verifying')
    expect(result.current.state.passkeyPending).toBe(false)
    expect(signIn).not.toHaveBeenCalled()
    await act(async () => {
      session.resolve({ data: null, error: null })
      await Promise.all(runs)
    })
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('releases the OTP lane when analytics fails and allows retry', async () => {
    const getSession = mock().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: null, error: null })
    const signIn = mock(async () => ({ data: { user: { id: 'u1', isNew: true } }, error: null }))
    const authClient = createMockAuthClient({ getSession, signInEmailOtp: signIn })
    const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
    act(() => result.current.actions.setEmail('test@example.com'))
    await act(() => result.current.actions.handleOtpComplete('12345678'))
    expect(result.current.state.status).toBe('checkEmail')
    expect(result.current.state.errorMessage).not.toBe('')
    await act(() => result.current.actions.handleOtpComplete('12345678'))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it.each(['reset', 'unmount'])('does not begin authentication after %s during analytics capture', async (end) => {
    const session = Promise.withResolvers<{ data: null; error: null }>()
    const signIn = mock(async () => ({ data: { user: { id: 'u1', isNew: true } }, error: null }))
    const authClient = createMockAuthClient({ getSession: () => session.promise, signInEmailOtp: signIn })
    const { result, unmount } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
    let pending: Promise<void>
    act(() => {
      pending = result.current.actions.handleOtpComplete('12345678')
    })
    if (end === 'reset') {
      act(() => result.current.actions.reset())
    } else {
      unmount()
    }
    await act(async () => {
      session.resolve({ data: null, error: null })
      await pending
    })
    expect(signIn).not.toHaveBeenCalled()
  })

  it.each(['reset', 'unmount'] as const)(
    'aborts pending OTP authentication on %s before it can publish credentials',
    async (end) => {
      const response = Promise.withResolvers<Response>()
      const requests: RequestInit[] = []
      const authClient = createAuthClient({
        baseURL: 'https://api.example.test',
        plugins: [emailOTPClient()],
        fetchOptions: {
          ...buildFetchOptions('web'),
          customFetchImpl: Object.assign(
            (input: string | URL | Request, options?: RequestInit) => {
              if (String(input).endsWith('/get-session')) {
                return Promise.resolve(Response.json(null))
              }
              requests.push(options ?? {})
              return response.promise
            },
            { preconnect: () => {} },
          ),
        },
      }) as unknown as AuthClient
      const { result, unmount } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
      act(() => result.current.actions.setEmail('test@example.com'))
      let pending: Promise<void>
      await act(async () => {
        pending = result.current.actions.handleOtpComplete('12345678')
        await getClock().tickAsync(0)
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.signal?.aborted).toBe(false)

      if (end === 'reset') {
        act(() => result.current.actions.reset())
      } else {
        unmount()
      }
      expect(requests[0]?.signal?.aborted).toBe(true)

      await act(async () => {
        response.resolve(
          Response.json(
            { user: { id: 'cancelled-user', email: 'test@example.com', isNew: false } },
            { headers: { 'set-auth-token': 'cancelled.signature' } },
          ),
        )
        await pending
      })
      expect(getAuthToken()).toBeNull()
      expect(authClient.$store.atoms.session.get().data).toBeNull()
      expect(await readOnboarding()).toBe('false')
      expect(useWelcomeStore.getState().pending).toBe(false)
      if (end === 'reset') {
        expect(result.current.state.status).toBe('idle')
      }
    },
  )

  it('keeps committed OTP housekeeping alive after reset and an auth-driven unmount', async () => {
    const onboarding = Promise.withResolvers<void>()
    const markOnboarded = spyOn(returningUserOnboarding, 'markOnboardedForReturningUser').mockImplementation(
      () => onboarding.promise,
    )
    const signIn = mock(async (_options: Parameters<AuthClient['signIn']['emailOtp']>[0]) => ({
      data: { user: { id: 'returning-user', isNew: false } },
      error: null,
    }))
    const authClient = createMockAuthClient({ signInEmailOtp: signIn })
    const { result, unmount } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
    let pending: Promise<void>
    try {
      await act(async () => {
        pending = result.current.actions.handleOtpComplete('12345678')
        await getClock().tickAsync(0)
      })
      expect(markOnboarded).toHaveBeenCalledTimes(1)
      const signal = signIn.mock.calls[0]?.[0].fetchOptions?.signal
      act(() => result.current.actions.reset())
      expect(result.current.state.status).toBe('verifying')
      expect(signal?.aborted).toBe(false)
      unmount()
      expect(signal?.aborted).toBe(false)
      await act(async () => {
        onboarding.resolve()
        await pending
      })
      expect(useWelcomeStore.getState().pending).toBe(true)
    } finally {
      markOnboarded.mockRestore()
    }
  })

  it.each(['reset', 'unmount'] as const)(
    'cancels an unfinished passkey sign-in on %s without showing a welcome',
    async (end) => {
      const ceremony = Promise.withResolvers<{ userId: string }>()
      const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation(() => ceremony.promise)
      try {
        const authClient = createMockAuthClient()
        const { result, unmount } = renderHook(() => useWaitlistState({ authClient }), {
          wrapper: createTestProvider(),
        })
        let pending: Promise<void>
        await act(async () => {
          pending = result.current.actions.handlePasskeySignIn()
          await getClock().tickAsync(0)
        })
        const signal = signIn.mock.calls[0]?.[1]?.signal
        expect(signal?.aborted).toBe(false)
        if (end === 'reset') {
          act(() => result.current.actions.reset())
        } else {
          unmount()
        }
        expect(signal?.aborted).toBe(true)
        await act(async () => {
          ceremony.resolve({ userId: 'cancelled-user' })
          await pending
        })
        expect(useWelcomeStore.getState().pending).toBe(false)
        if (end === 'reset') {
          expect(result.current.state.status).toBe('idle')
        }
      } finally {
        signIn.mockRestore()
      }
    },
  )

  it('finishes a committed passkey sign-in after the auth redirect unmounts the page', async () => {
    const completion = Promise.withResolvers<{ userId: string }>()
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation((_client, options) => {
      options?.onAuthenticated?.()
      return completion.promise
    })
    try {
      const authClient = createMockAuthClient()
      const { result, unmount } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
      let pending: Promise<void>
      await act(async () => {
        pending = result.current.actions.handlePasskeySignIn()
        await getClock().tickAsync(0)
      })
      const signal = signIn.mock.calls[0]?.[1]?.signal
      act(() => result.current.actions.reset())
      expect(result.current.state.passkeyPending).toBe(true)
      unmount()
      expect(signal?.aborted).toBe(false)
      await act(async () => {
        completion.resolve({ userId: 'returning-user' })
        await pending
      })
      expect(useWelcomeStore.getState().pending).toBe(true)
    } finally {
      signIn.mockRestore()
    }
  })

  it('recovers from a passkey analytics failure before opening the browser prompt', async () => {
    const getSession = mock().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: null, error: null })
    const signIn = spyOn(passkeys, 'signInWithPasskey').mockResolvedValue({ userId: 'existing-user' })
    try {
      const authClient = createMockAuthClient({ getSession })
      const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
      await act(() => result.current.actions.handlePasskeySignIn())
      expect(result.current.state.status).toBe('error')
      expect(result.current.state.passkeyPending).toBe(false)
      expect(signIn).not.toHaveBeenCalled()
      await act(() => result.current.actions.handlePasskeySignIn())
      expect(signIn).toHaveBeenCalledTimes(1)
      expect(useWelcomeStore.getState().pending).toBe(true)
    } finally {
      signIn.mockRestore()
    }
  })

  it.each([new DOMException('cancelled', 'NotAllowedError'), new Error('ceremony failed')])(
    'settles a failed passkey ceremony: %p',
    async (error) => {
      const signIn = spyOn(passkeys, 'signInWithPasskey').mockRejectedValue(error)
      try {
        const authClient = createMockAuthClient()
        const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
        await act(() => result.current.actions.handlePasskeySignIn())
        expect(result.current.state.status).toBe(error.name === 'NotAllowedError' ? 'idle' : 'error')
        expect(result.current.state.passkeyPending).toBe(false)
        expect(useWelcomeStore.getState().pending).toBe(false)
      } finally {
        signIn.mockRestore()
      }
    },
  )

  it('rejects incomplete OTPs and surfaces a rejected complete OTP', async () => {
    const signIn = mock(async () => ({
      data: null,
      error: { message: 'Invalid OTP', code: 'INVALID_OTP', status: 400, statusText: 'Bad Request' },
    }))
    const authClient = createMockAuthClient({ signInEmailOtp: signIn })
    const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })
    await act(() => result.current.actions.handleOtpComplete('123'))
    expect(signIn).not.toHaveBeenCalled()
    act(() => result.current.actions.setOtp('12345678'))
    await act(() => result.current.actions.handleOtpComplete('12345678'))
    expect(result.current.state.status).toBe('checkEmail')
    expect(result.current.state.otp).toBe('')
    expect(result.current.state.errorMessage).not.toBe('')
  })

  it('ignores a join response after Reset starts a new email attempt', async () => {
    const old = Promise.withResolvers<Response>()
    const httpClient = createClient({
      prefixUrl: 'https://example.com',
      fetch: (input) => {
        const url = String(input instanceof Request ? input.url : input)
        return url.endsWith('/waitlist/join') ? old.promise : Promise.resolve(Response.json({}))
      },
    })
    const authClient = createMockAuthClient()
    const { result } = renderHook(() => useWaitlistState({ authClient }), {
      wrapper: createTestProvider({ httpClient }),
    })
    act(() => result.current.actions.setEmail('old@example.com'))
    let pending: Promise<void>
    const event = { preventDefault: () => {} } as FormEvent
    act(() => {
      pending = result.current.actions.handleSubmit(event)
    })
    act(() => {
      result.current.actions.reset()
      result.current.actions.setEmail('new@example.com')
    })
    await act(async () => {
      old.resolve(Response.json({ success: true, challengeToken: 'old' }))
      await pending
      await getClock().tickAsync(0)
    })
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.email).toBe('new@example.com')
    expect(result.current.state.challengeToken).toBe('')
  })
})
