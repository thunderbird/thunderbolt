/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode, type ReactNode } from 'react'
import { useAuthGate } from './use-auth-gate'

const wrapInStrictMode = (Wrapper: (props: { children: ReactNode }) => ReactNode) => {
  const StrictWrapper = ({ children }: { children: ReactNode }) =>
    createElement(StrictMode, null, createElement(Wrapper as never, null, children))
  return StrictWrapper
}

const realSession = {
  user: { id: '1', email: 'u@example.com', name: 'User' },
}

const anonymousSession = {
  user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anon', isAnonymous: true },
}

type EnvOverrides = {
  VITE_AUTH_MODE?: string
  VITE_AUTH_ENABLE_ANONYMOUS?: string
  VITE_BYPASS_WAITLIST?: string
}

/**
 * Stash and restore selected import.meta.env overrides for a test. The hook
 * reads env via `isSsoMode()` / `isAnonymousAuthEnabled()` / inline bypass
 * check, all of which read `import.meta.env` at call time.
 */
const withEnv = (overrides: EnvOverrides) => {
  const env = import.meta.env as unknown as Record<string, string | undefined>
  const original: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides) as (keyof EnvOverrides)[]) {
    original[key] = env[key]
    env[key] = overrides[key]
  }
  return () => {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) {
        delete env[key]
      } else {
        env[key] = original[key]
      }
    }
  }
}

const createAuthClientWithAnonSpy = (params: {
  initialSession?: typeof realSession | null
  initialPending?: boolean
  sessionAfterSignIn?: typeof realSession | typeof anonymousSession
  signInError?: Error
  signInResolvesError?: { status: number; code: string }
}) => {
  const sessionRef = { current: params.initialSession ?? null }
  const pendingRef = { current: params.initialPending ?? false }
  const signInSpy = mock(() => {})
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
        signInSpy()
        if (params.signInError) {
          throw params.signInError
        }
        if (params.sessionAfterSignIn) {
          sessionRef.current = params.sessionAfterSignIn
          pendingRef.current = false
        }
        return {
          error: params.signInResolvesError ?? null,
          data: params.signInResolvesError ? null : { user: { id: 'anon-mock' } },
        }
      },
    },
  } as unknown as AuthClient
  return { authClient, signInSpy, sessionRef, pendingRef }
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

let restoreEnv: () => void = () => {}

beforeEach(() => {
  restoreEnv = withEnv({
    VITE_AUTH_MODE: undefined,
    VITE_AUTH_ENABLE_ANONYMOUS: undefined,
    VITE_BYPASS_WAITLIST: undefined,
  })
})

afterEach(() => {
  restoreEnv()
})

describe('useAuthGate — require="authenticated"', () => {
  it('returns loading while session fetch is pending', () => {
    const authClient = createMockAuthClient({ session: null, isPending: true })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'loading' })
  })

  it('returns allowed when a real session is present', () => {
    const authClient = createMockAuthClient({ session: realSession, isPending: false })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'allowed' })
  })

  it('returns allowed when an anonymous session is present (anon counts as authenticated)', () => {
    const authClient = createMockAuthClient({ session: anonymousSession, isPending: false })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'allowed' })
  })

  it('returns redirect to sso when no session and SSO mode is active', () => {
    restoreEnv()
    restoreEnv = withEnv({ VITE_AUTH_MODE: 'sso' })
    const authClient = createMockAuthClient({ session: null, isPending: false })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'redirect', target: 'sso' })
  })

  it('returns redirect to waitlist when no session and waitlist is active', () => {
    const authClient = createMockAuthClient({ session: null, isPending: false })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'redirect', target: 'waitlist' })
  })

  it('fires signIn.anonymous and shows loading when no session, waitlist bypassed, and anonymous allowed', async () => {
    restoreEnv()
    restoreEnv = withEnv({ VITE_AUTH_ENABLE_ANONYMOUS: 'true', VITE_BYPASS_WAITLIST: 'true' })
    const { authClient, signInSpy } = createAuthClientWithAnonSpy({
      initialSession: null,
      initialPending: false,
      sessionAfterSignIn: anonymousSession,
    })
    const wrapper = createTestProvider({ authClient })
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() => expect(signInSpy).toHaveBeenCalledTimes(1))
    rerender()
    await waitFor(() => expect(result.current).toEqual({ status: 'allowed' }))
  })

  it('does NOT call signIn.anonymous when anonymous is enabled but SSO mode is active (mutex)', async () => {
    restoreEnv()
    restoreEnv = withEnv({
      VITE_AUTH_MODE: 'sso',
      VITE_AUTH_ENABLE_ANONYMOUS: 'true',
      VITE_BYPASS_WAITLIST: 'true',
    })
    const { authClient, signInSpy } = createAuthClientWithAnonSpy({
      initialSession: null,
      initialPending: false,
    })
    const wrapper = createTestProvider({ authClient })
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    // Force a few renders to confirm no effect fires
    rerender()
    rerender()
    expect(signInSpy).not.toHaveBeenCalled()
    expect(result.current).toEqual({ status: 'redirect', target: 'sso' })
  })

  it('does NOT call signIn.anonymous when anonymous is enabled but waitlist is active (no bypass)', () => {
    restoreEnv()
    restoreEnv = withEnv({ VITE_AUTH_ENABLE_ANONYMOUS: 'true' })
    const { authClient, signInSpy } = createAuthClientWithAnonSpy({
      initialSession: null,
      initialPending: false,
    })
    const wrapper = createTestProvider({ authClient })
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    rerender()
    rerender()
    expect(signInSpy).not.toHaveBeenCalled()
    expect(result.current).toEqual({ status: 'redirect', target: 'waitlist' })
  })

  it('fires signIn.anonymous exactly once even under React StrictMode double-invoke', async () => {
    restoreEnv()
    restoreEnv = withEnv({ VITE_AUTH_ENABLE_ANONYMOUS: 'true', VITE_BYPASS_WAITLIST: 'true' })
    const { authClient, signInSpy } = createAuthClientWithAnonSpy({
      initialSession: null,
      initialPending: false,
      sessionAfterSignIn: anonymousSession,
    })
    const baseWrapper = createTestProvider({ authClient })
    const wrapper = wrapInStrictMode(baseWrapper)
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    await waitFor(() => expect(signInSpy).toHaveBeenCalledTimes(1))
    rerender()
    rerender()
    await waitFor(() => expect(result.current).toEqual({ status: 'allowed' }))
    expect(signInSpy).toHaveBeenCalledTimes(1)
  })
})

describe('useAuthGate — require="unauthenticated"', () => {
  it('returns redirect to home when a session is present', () => {
    const authClient = createMockAuthClient({ session: realSession, isPending: false })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'redirect', target: 'home' })
  })

  it('returns allowed when no session is present', () => {
    const authClient = createMockAuthClient({ session: null, isPending: false })
    const wrapper = createTestProvider({ authClient })
    const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
    expect(result.current).toEqual({ status: 'allowed' })
  })

  it('returns loading while pending (no auto-anon for unauthenticated routes)', () => {
    restoreEnv()
    restoreEnv = withEnv({ VITE_AUTH_ENABLE_ANONYMOUS: 'true', VITE_BYPASS_WAITLIST: 'true' })
    const { authClient, signInSpy } = createAuthClientWithAnonSpy({
      initialSession: null,
      initialPending: true,
    })
    const wrapper = createTestProvider({ authClient })
    const { result, rerender } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })

    expect(result.current).toEqual({ status: 'loading' })
    rerender()
    rerender()
    // Anonymous auto-create must never fire on unauthenticated routes — would loop forever.
    expect(signInSpy).not.toHaveBeenCalled()
  })
})
