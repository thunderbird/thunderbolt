/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode, useEffect, type ReactNode } from 'react'
import { useAnonymousSessionGuard } from './use-anonymous-session-guard'

const wrapInStrictMode = (Wrapper: (props: { children: ReactNode }) => ReactNode) => {
  const StrictWrapper = ({ children }: { children: ReactNode }) =>
    createElement(StrictMode, null, createElement(Wrapper as never, null, children))
  return StrictWrapper
}

type AnonymousImpl = () => Promise<{ error: unknown; data: unknown }>

const createAuthClientWithAnon = (anonymous: AnonymousImpl): AuthClient =>
  ({
    ...createMockAuthClient({ session: null, isPending: false }),
    signIn: {
      emailOtp: async () => ({ error: null }),
      anonymous,
    },
  }) as unknown as AuthClient

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(() => {
  localStorage.removeItem('thunderbolt_auth_token')
})

const sessionWithUser = {
  user: { id: '1', email: 'u@example.com', name: 'User' },
}

const anonymousSession = {
  user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anon', isAnonymous: true },
}

const createGuardClient = (params: {
  initialSession: typeof sessionWithUser | null
  initialPending: boolean
  signInAnonymous: ReturnType<typeof mock>
  sessionAfterSignIn?: typeof sessionWithUser
}) => {
  const sessionRef = { current: params.initialSession }
  const pendingRef = { current: params.initialPending }
  const authClient = {
    ...createMockAuthClient(),
    useSession: () => ({
      data: sessionRef.current,
      isPending: pendingRef.current,
      isRefetching: false,
      error: null,
      refetch: async () => {},
    }),
    signIn: {
      emailOtp: async () => ({ error: null }),
      anonymous: async () => {
        params.signInAnonymous()
        if (params.sessionAfterSignIn) {
          sessionRef.current = params.sessionAfterSignIn
          pendingRef.current = false
        }
        return { error: null, data: { user: { id: params.sessionAfterSignIn?.user.id ?? 'anon-mock' } } }
      },
    },
  } as unknown as AuthClient
  return { authClient, sessionRef, pendingRef }
}

describe('useAnonymousSessionGuard', () => {
  describe('returns loading', () => {
    it('while initial session fetch is pending and no token exists', () => {
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: null,
        initialPending: true,
        signInAnonymous: signInSpy,
      })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      expect(result.current).toEqual({ status: 'loading' })
    })

    it('while anonymous sign-in is in flight', async () => {
      const signInSpy = mock(() => {})
      let resolveSignIn = () => {}
      const signInPromise = new Promise<void>((resolve) => {
        resolveSignIn = resolve
      })
      const authClient = createAuthClientWithAnon(async () => {
        signInSpy()
        await signInPromise
        return { error: null, data: { user: { id: 'anon-mock' } } }
      })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      await waitFor(() => expect(signInSpy).toHaveBeenCalledTimes(1))
      expect(result.current).toEqual({ status: 'loading' })
      await act(async () => {
        resolveSignIn()
        await signInPromise
      })
    })
  })

  describe('returns ready', () => {
    it('when a real session is already loaded — no anonymous sign-in attempted', () => {
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: sessionWithUser,
        initialPending: false,
        signInAnonymous: signInSpy,
      })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      expect(result.current).toEqual({ status: 'ready' })
      expect(signInSpy).not.toHaveBeenCalled()
    })

    it('when an anonymous session is already loaded — no second sign-in attempted', () => {
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: anonymousSession,
        initialPending: false,
        signInAnonymous: signInSpy,
      })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      expect(result.current).toEqual({ status: 'ready' })
      expect(signInSpy).not.toHaveBeenCalled()
    })

    it('when a stored token exists (token-first) — no anonymous sign-in attempted', () => {
      localStorage.setItem('thunderbolt_auth_token', 'stored-token')
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: null,
        initialPending: false,
        signInAnonymous: signInSpy,
      })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      expect(result.current).toEqual({ status: 'ready' })
      expect(signInSpy).not.toHaveBeenCalled()
    })

    it('when token exists and session is still pending — token-first short-circuits loading', () => {
      localStorage.setItem('thunderbolt_auth_token', 'stored-token')
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: null,
        initialPending: true,
        signInAnonymous: signInSpy,
      })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      expect(result.current).toEqual({ status: 'ready' })
      expect(signInSpy).not.toHaveBeenCalled()
    })
  })

  describe('anonymous sign-in flow', () => {
    it('triggers signIn.anonymous when session resolves as null and no token exists, then becomes ready', async () => {
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: null,
        initialPending: false,
        signInAnonymous: signInSpy,
        sessionAfterSignIn: anonymousSession,
      })
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      await waitFor(() => expect(signInSpy).toHaveBeenCalledTimes(1))
      rerender()
      await waitFor(() => expect(result.current).toEqual({ status: 'ready' }))
    })

    it('does NOT retry on failure — sign-in fires exactly once even when it rejects', async () => {
      const signInSpy = mock(() => {})
      const authClient = createAuthClientWithAnon(async () => {
        signInSpy()
        throw new Error('network-down')
      })
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      await waitFor(() => expect(signInSpy).toHaveBeenCalledTimes(1))
      // Force several rerenders to ensure no retry storm
      rerender()
      rerender()
      rerender()
      await waitFor(() => expect(result.current).toEqual({ status: 'ready' }))
      expect(signInSpy).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry when signIn.anonymous resolves with { error } (Better Auth path)', async () => {
      const signInSpy = mock(() => {})
      const authClient = createAuthClientWithAnon(async () => {
        signInSpy()
        return { error: { status: 500, code: 'BACKEND_DOWN', message: 'fail' }, data: null }
      })
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      await waitFor(() => expect(signInSpy).toHaveBeenCalledTimes(1))
      rerender()
      rerender()
      rerender()
      await waitFor(() => expect(result.current).toEqual({ status: 'ready' }))
      expect(signInSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('React StrictMode', () => {
    // React 19 (this project's version) removed strict-effects double-invoke. The setup→cleanup→setup
    // simulation that existed in React 18 dev mode is gone — see facebook/react#35017 and the React 19
    // changelog. This pair of tests pins that behavior so we get a failing canary if it ever changes,
    // and demonstrates that `triedRef`-based dedup remains correct regardless.
    it('documents that React 19 StrictMode does NOT simulate effect remount (1 setup, not 2)', () => {
      let effectSetups = 0
      const useProbe = () => {
        useEffect(() => {
          effectSetups += 1
        }, [])
      }
      const baseWrapper = createTestProvider({ authClient: createMockAuthClient() })
      const wrapper = wrapInStrictMode(baseWrapper)
      renderHook(useProbe, { wrapper })
      // React 18 would have made this 2 (strict-effects). React 19 makes it 1.
      // If this ever flips to 2, re-evaluate the `triedRef` dedup logic — Better Auth
      // would receive a duplicate /sign-in/anonymous call in dev.
      expect(effectSetups).toBe(1)
    })

    it('fires signIn.anonymous exactly once even when wrapped in StrictMode', async () => {
      const signInSpy = mock(() => {})
      const { authClient } = createGuardClient({
        initialSession: null,
        initialPending: false,
        signInAnonymous: signInSpy,
        sessionAfterSignIn: anonymousSession,
      })
      const baseWrapper = createTestProvider({ authClient })
      const wrapper = wrapInStrictMode(baseWrapper)
      const { result } = renderHook(() => useAnonymousSessionGuard(), { wrapper })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(signInSpy).toHaveBeenCalledTimes(1)
      expect(result.current).toEqual({ status: 'ready' })
    })
  })
})
