/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { createChallenge, verifySolution } from 'altcha-lib/v1'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { Component, createElement, StrictMode, type ReactNode } from 'react'
import { useAuthGate, type AuthGateState } from './use-auth-gate'

type ErrorCaptureState = { error: Error | null }

/**
 * Minimal error boundary that records the caught error on a shared object so
 * tests can assert that the wrapped component threw. Used to verify the gate
 * surfaces signIn errors (a thrown error here is the in-band signal to render
 * an error UI in production).
 */
class TestErrorBoundary extends Component<{ capture: ErrorCaptureState; children: ReactNode }> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error) {
    this.props.capture.error = error
  }
  render() {
    if (this.state.hasError) {
      return null
    }
    return this.props.children
  }
}

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

// auth-mode reads `import.meta.env` on every call (no memoization), so tests
// control SSO / anonymous / waitlist behavior by mutating the env directly.
// Each test reads via a fresh hook render, so per-test mutation propagates
// cleanly without the cross-file leak that `mock.module('@/lib/auth-mode')`
// caused under `--randomize`.
const env = import.meta.env as Record<string, string | undefined>

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

afterEach(() => {
  delete env.VITE_AUTH_MODE
  delete env.VITE_AUTH_ENABLE_ANONYMOUS
  delete env.VITE_BYPASS_WAITLIST
  delete env.VITE_CAPTCHA_PROVIDER
  delete env.VITE_APP_VERSION
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
    env.VITE_AUTH_MODE = 'sso'
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
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
    env.VITE_BYPASS_WAITLIST = 'true'
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
    env.VITE_AUTH_MODE = 'sso'
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
    env.VITE_BYPASS_WAITLIST = 'true'
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
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
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

  it('throws to error boundary when signIn.anonymous resolves with { error } (e.g. HTTP 429)', async () => {
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
    env.VITE_BYPASS_WAITLIST = 'true'
    const { authClient, signInSpy } = createAuthClientWithAnonSpy({
      initialSession: null,
      initialPending: false,
      signInResolvesError: { status: 429, code: 'TOO_MANY_REQUESTS' },
    })
    const Provider = createTestProvider({ authClient })

    // We don't use renderHook here because the hook is supposed to throw during
    // render, and we want an error boundary to absorb that throw so the test
    // can observe it without crashing the renderer.
    const capture: ErrorCaptureState = { error: null }
    const Consumer = () => {
      useAuthGate('authenticated')
      return null
    }
    const tree = createElement(Provider, null, [
      createElement(TestErrorBoundary, { key: 'boundary', capture, children: createElement(Consumer) }),
    ])
    render(tree)

    // Flush the effect's async signIn + the resulting setAnonError → re-render
    // → throw → error boundary cycle. Fake timers + microtasks need explicit
    // advancement here; waitFor stalls because the gate's render throws.
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(signInSpy).toHaveBeenCalledTimes(1)
    expect(capture.error).toBeInstanceOf(Error)
  })

  it('fires signIn.anonymous exactly once even under React StrictMode double-invoke', async () => {
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
    env.VITE_BYPASS_WAITLIST = 'true'
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

const altchaKey = 'test-altcha-hmac-key-that-is-32-characters'
const captchaFailed = { status: 403, code: 'CAPTCHA_VERIFICATION_FAILED', message: 'Captcha verification failed' }

type SignInOptions = { fetchOptions?: { headers?: Record<string, string>; signal?: AbortSignal } }

/**
 * An auth client whose anonymous sign-in answers from `results` in order (`null` succeeds and
 * sets the anonymous session), plus an HttpClient serving real, easy ALTCHA challenges.
 * Challenge fetches fail in order with `challengeFailures` (a network error, a challenge the
 * worker cannot hash, or that HTTP status) and wait for `challengeHeld`; sign-in waits for
 * `signInHeld`.
 */
type ChallengeFailure = 'network' | 'worker' | number

const createCaptchaClients = (params: {
  results: Array<typeof captchaFailed | null>
  challengeFailures?: ChallengeFailure[]
  signInHeld?: Promise<void>
  challengeHeld?: Promise<void>
}) => {
  const sessionRef: { current: typeof anonymousSession | null } = { current: null }
  const signInCalls: Array<SignInOptions | undefined> = []
  const challenges: string[] = []
  const challengeSignals: AbortSignal[] = []
  const authClient = {
    ...createMockAuthClient(),
    useSession: () => ({
      data: sessionRef.current,
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: async () => {},
    }),
    signIn: {
      emailOtp: async () => ({ error: null }),
      anonymous: async (options?: SignInOptions) => {
        const error = params.results[signInCalls.length] ?? null
        signInCalls.push(options)
        await params.signInHeld
        if (!error) {
          sessionRef.current = anonymousSession
        }
        return { error, data: error ? null : { user: { id: 'anon-mock' } } }
      },
    },
  } as unknown as AuthClient
  const fetchChallenge = async (input: RequestInfo | URL) => {
    challengeSignals.push((input as Request).signal)
    await params.challengeHeld
    const failure = params.challengeFailures?.[challenges.length]
    const challenge = await createChallenge({ hmacKey: altchaKey, maxnumber: 1000, algorithm: 'SHA-256' })
    challenges.push(failure === undefined ? challenge.challenge : `failed:${failure}`)
    if (failure === 'network') {
      throw new TypeError('Failed to fetch')
    }
    if (failure === 'worker') {
      // crypto.subtle rejects the algorithm inside the worker, which surfaces as its `error` event.
      return Response.json({ ...challenge, algorithm: 'NOPE' })
    }
    if (typeof failure === 'number') {
      return new Response('refused', { status: failure })
    }
    return Response.json(challenge)
  }
  const httpClient = createClient({ fetch: fetchChallenge, prefixUrl: 'http://test-api.local' })
  return { authClient, httpClient, signInCalls, challenges, challengeSignals }
}

/** Render the gate under an error boundary, recording every status it renders and the latest state. */
const renderGateWithBoundary = (clients: ReturnType<typeof createCaptchaClients>) => {
  const Provider = createTestProvider({ authClient: clients.authClient, httpClient: clients.httpClient })
  const capture: ErrorCaptureState = { error: null }
  const statuses: string[] = []
  const latest: { state: AuthGateState | null } = { state: null }
  const Consumer = () => {
    latest.state = useAuthGate('authenticated')
    statuses.push(latest.state.status)
    return null
  }
  render(
    createElement(Provider, null, createElement(TestErrorBoundary, { capture, children: createElement(Consumer) })),
  )
  /** Click the retry button of the failed state the gate is showing. */
  const retry = () => act(() => (latest.state as { retry: () => void }).retry())
  return { capture, statuses, latest, retry }
}

describe('useAuthGate with VITE_CAPTCHA_PROVIDER=altcha', () => {
  beforeEach(() => {
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
    env.VITE_BYPASS_WAITLIST = 'true'
    env.VITE_CAPTCHA_PROVIDER = 'altcha'
    // The solver runs in real Workers, whose messages never reach the fake clock.
    getClock().uninstall()
  })

  it('with the provider unset, signs in as before: no challenge, no captcha header, no verifying state', async () => {
    delete env.VITE_CAPTCHA_PROVIDER
    const signInHeld = Promise.withResolvers<void>()
    const { authClient, httpClient, signInCalls, challenges } = createCaptchaClients({
      results: [null],
      signInHeld: signInHeld.promise,
    })
    const wrapper = createTestProvider({ authClient, httpClient })
    const statuses: string[] = []
    const { result, rerender } = renderHook(
      () => {
        const state = useAuthGate('authenticated')
        statuses.push(state.status)
        return state
      },
      { wrapper },
    )

    // Held open so a state set before the sign-in resolves gets a render of its own.
    await waitFor(() => expect(signInCalls).toEqual([undefined]))
    rerender()
    expect(result.current).toEqual({ status: 'loading' })
    signInHeld.resolve()
    await waitFor(() => {
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })
    expect(statuses).not.toContain('verifying')
    expect(challenges).toHaveLength(0)
  })

  it('signs in with a valid solution in x-captcha-token, keeping the app headers', async () => {
    env.VITE_APP_VERSION = '1.2.3'
    const { authClient, httpClient, signInCalls } = createCaptchaClients({ results: [null] })
    const wrapper = createTestProvider({ authClient, httpClient })
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    await waitFor(() => expect(result.current).toEqual({ status: 'verifying' }))
    await waitFor(() => expect(signInCalls).toHaveLength(1), { timeout: 2000 })
    const headers = signInCalls[0]?.fetchOptions?.headers ?? {}
    expect(await verifySolution(headers['x-captcha-token'], altchaKey)).toBe(true)
    expect(headers['X-App-Version']).toBe('1.2.3')
    expect(headers['X-Client-Platform']).toBeDefined()
    rerender()
    await waitFor(() => expect(result.current).toEqual({ status: 'allowed' }))
  })

  it('offers a retry on a 403 CAPTCHA_VERIFICATION_FAILED, and the retry solves a fresh challenge', async () => {
    const { authClient, httpClient, signInCalls, challenges } = createCaptchaClients({ results: [captchaFailed, null] })
    const wrapper = createTestProvider({ authClient, httpClient })
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('verification-failed'), { timeout: 2000 })
    act(() => (result.current as { retry: () => void }).retry())
    await waitFor(() => expect(signInCalls).toHaveLength(2), { timeout: 2000 })
    expect(challenges).toHaveLength(2)
    expect(challenges[1]).not.toBe(challenges[0])
    rerender()
    await waitFor(() => expect(result.current).toEqual({ status: 'allowed' }))
  })

  it('ignores a second retry click while the first solve is in flight', async () => {
    const { authClient, httpClient, signInCalls, challenges } = createCaptchaClients({ results: [captchaFailed, null] })
    const wrapper = createTestProvider({ authClient, httpClient })
    const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('verification-failed'), { timeout: 2000 })
    const { retry } = result.current as { retry: () => void }
    act(() => {
      retry()
      retry()
    })
    await waitFor(() => expect(signInCalls).toHaveLength(2), { timeout: 2000 })
    rerender()
    await waitFor(() => expect(result.current).toEqual({ status: 'allowed' }))
    expect(challenges).toHaveLength(2)
    expect(signInCalls).toHaveLength(2)
  })

  it('never signs in from an attempt whose gate unmounted during the challenge fetch', async () => {
    const challengeHeld = Promise.withResolvers<void>()
    const { authClient, httpClient, signInCalls, challenges, challengeSignals } = createCaptchaClients({
      results: [null],
      challengeHeld: challengeHeld.promise,
    })
    const wrapper = createTestProvider({ authClient, httpClient })
    const { result, unmount } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    await waitFor(() => expect(result.current).toEqual({ status: 'verifying' }))
    unmount()
    expect(challengeSignals[0]?.aborted).toBe(true)
    challengeHeld.resolve()
    await waitFor(() => expect(challenges).toHaveLength(1))
    // Long enough for a surviving attempt to solve the easy challenge and sign in.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(signInCalls).toHaveLength(0)
  })

  it('cancels the sign-in request when the gate unmounts while it is in flight', async () => {
    const signInHeld = Promise.withResolvers<void>()
    const { authClient, httpClient, signInCalls } = createCaptchaClients({
      results: [null],
      signInHeld: signInHeld.promise,
    })
    const wrapper = createTestProvider({ authClient, httpClient })
    const { unmount } = renderHook(() => useAuthGate('authenticated'), { wrapper })

    await waitFor(() => expect(signInCalls).toHaveLength(1), { timeout: 2000 })
    const signal = signInCalls[0]?.fetchOptions?.signal
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
    signInHeld.resolve()
  })

  it('offers a retry without signing in when the challenge fetch hits a network error', async () => {
    const clients = createCaptchaClients({ results: [null], challengeFailures: ['network'] })
    const { capture, latest, retry } = renderGateWithBoundary(clients)

    await waitFor(() => expect(latest.state?.status).toBe('verification-failed'))
    expect(clients.signInCalls).toHaveLength(0)
    retry()
    await waitFor(() => expect(clients.signInCalls).toHaveLength(1), { timeout: 2000 })
    expect(capture.error).toBeNull()
  })

  it.each([503, 'worker'] as const)('offers a retry when the challenge fails transiently (%p)', async (failure) => {
    const clients = createCaptchaClients({ results: [null], challengeFailures: [failure] })
    const { capture, latest } = renderGateWithBoundary(clients)

    await waitFor(() => expect(latest.state?.status).toBe('verification-failed'), { timeout: 2000 })
    expect(clients.signInCalls).toHaveLength(0)
    expect(capture.error).toBeNull()
  })

  it.each([404, 429])('sends a %d on the challenge to the error boundary, never offering a retry', async (status) => {
    const clients = createCaptchaClients({ results: [null], challengeFailures: [status] })
    const { capture, statuses } = renderGateWithBoundary(clients)

    await waitFor(() => expect(capture.error).toBeInstanceOf(Error), { timeout: 2000 })
    expect(statuses).not.toContain('verification-failed')
    expect(clients.signInCalls).toHaveLength(0)
  })

  it('sends a sign-in error other than the captcha 403 (a 429) to the error boundary', async () => {
    const tooMany = { status: 429, code: 'TOO_MANY_REQUESTS', message: 'Too many requests' }
    const { capture, statuses } = renderGateWithBoundary(
      createCaptchaClients({ results: [tooMany as typeof captchaFailed] }),
    )

    await waitFor(() => expect(capture.error).toBeInstanceOf(Error), { timeout: 2000 })
    expect(statuses).not.toContain('verification-failed')
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
    env.VITE_AUTH_ENABLE_ANONYMOUS = 'true'
    env.VITE_BYPASS_WAITLIST = 'true'
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
