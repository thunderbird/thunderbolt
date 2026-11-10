/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { setActiveLocale } from '@/i18n/active-locale'
import { resetAppVersionBlockedForTesting } from '@/lib/app-version-unsupported'
import { clearAuthToken, getAuthToken, invalidateAuthRequests, setAuthToken } from '@/lib/auth-token'
import { clearCachedSession, getCachedSession, setCachedSession } from '@/lib/session-cache'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getPlatform } from '@/lib/platform'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  authRequestHeaders,
  buildFetchOptions,
  hydrateSessionFromCache,
  subscribeSessionCachePersist,
  createAuthClientInstance,
  standaloneAuthFetch,
} from './auth-context'
import { createAuthClient } from 'better-auth/react'
import { getClock } from '@/testing-library'

const authTokenKey = 'thunderbolt_auth_token'
const sessionCacheKey = 'thunderbolt_session_cache'

const fireStorageEvent = (newValue: string | null, oldValue: string | null) => {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: authTokenKey,
      newValue,
      oldValue,
      storageArea: localStorage,
    }),
  )
}

const originalDispatch = window.dispatchEvent

describe('standalone authentication', () => {
  it('starts signed out without hydrating a previous server session', () => {
    setAuthToken('old-server-token')
    const client = createAuthClientInstance('')
    expect(client.$store.atoms.session.get()).toMatchObject({ data: null, isPending: false })
    clearAuthToken()
  })

  it('handles session reads locally and rejects sign-in until a server is selected', async () => {
    expect(await (await standaloneAuthFetch('https://standalone.invalid/v1/api/auth/get-session')).json()).toBeNull()
    const signIn = await standaloneAuthFetch('https://standalone.invalid/v1/api/auth/sign-in/email-otp')
    expect(signIn.status).toBe(503)
    expect(await signIn.json()).toMatchObject({ code: 'SERVER_NOT_CONFIGURED' })
  })
})

describe('authRequestHeaders', () => {
  const env = import.meta.env as Record<string, unknown>
  let savedVersion: unknown

  beforeEach(() => {
    savedVersion = env.VITE_APP_VERSION
  })

  afterEach(() => {
    if (savedVersion === undefined) {
      delete env.VITE_APP_VERSION
    } else {
      env.VITE_APP_VERSION = savedVersion
    }
  })

  it('carries the app version alongside a per-call header', () => {
    env.VITE_APP_VERSION = '1.2.3'

    const headers = authRequestHeaders({ 'X-Challenge-Token': 'tok' })

    expect(headers['X-App-Version']).toBe('1.2.3')
    expect(headers['X-Challenge-Token']).toBe('tok')
    expect(headers['X-Client-Platform']).toBeTruthy()
  })

  it('matches the headers the client applies when no extras are passed', () => {
    env.VITE_APP_VERSION = '1.2.3'

    const applied = new Headers()
    buildFetchOptions(getPlatform()).onRequest({ headers: applied })

    const expected = authRequestHeaders()
    expect([...applied.keys()]).toHaveLength(Object.keys(expected).length)
    for (const [key, value] of Object.entries(expected)) {
      expect(applied.get(key)).toBe(value)
    }
  })
})

describe('buildFetchOptions onRequest', () => {
  afterEach(() => {
    setActiveLocale('en')
    localStorage.removeItem('thunderbolt_locale')
  })

  const runOnRequest = (existing?: HeadersInit) => {
    const headers = new Headers(existing)
    buildFetchOptions('web').onRequest({ headers })
    return headers
  }

  it('sets the platform and app language on every request', () => {
    setActiveLocale('ja')

    const headers = runOnRequest()

    expect(headers.get('X-Client-Platform')).toBe('web')
    expect(headers.get('X-App-Language')).toBe('ja')
  })

  // better-fetch merges client and per-call options with a shallow spread, so a
  // call that passes its own `fetchOptions.headers` (OTP verify, magic-link
  // verify) would lose anything set via client-level `headers`. Setting them in
  // `onRequest` is what keeps them alongside the caller's own headers.
  it('survives alongside per-call headers', () => {
    setActiveLocale('pt-BR')

    const headers = runOnRequest({ 'X-Challenge-Token': 'challenge' })

    expect(headers.get('X-Challenge-Token')).toBe('challenge')
    expect(headers.get('X-Client-Platform')).toBe('web')
    expect(headers.get('X-App-Language')).toBe('pt-BR')
  })

  it('reads the locale per request rather than at client construction', () => {
    const options = buildFetchOptions('web')

    setActiveLocale('de')
    const first = new Headers()
    options.onRequest({ headers: first })

    setActiveLocale('fr')
    const second = new Headers()
    options.onRequest({ headers: second })

    expect(first.get('X-App-Language')).toBe('de')
    expect(second.get('X-App-Language')).toBe('fr')
  })
})

describe('buildFetchOptions onError', () => {
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    resetAppVersionBlockedForTesting()
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
    clearAuthToken()
    clearCachedSession()
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
    clearAuthToken()
    clearCachedSession()
    // The 426 test latches the module-level `versionBlocked` singleton; leaving
    // it set breaks later files that assert the app is not version-blocked.
    resetAppVersionBlockedForTesting()
  })

  const trigger401 = () => {
    const options = buildFetchOptions('web')
    options.onError({
      request: { headers: new Headers(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}) },
      response: new Response(null, { status: 401 }),
    })
  }

  it('dispatches session_expired when a stored token is rejected with 401', () => {
    setAuthToken('stale-token')

    trigger401()

    expect(getAuthToken()).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('powersync_credentials_invalid')
    expect(event.detail).toEqual({ reason: 'session_expired' })
  })

  it('does not dispatch on 401 when no token was stored (e.g. wrong OTP at sign-in)', () => {
    expect(getAuthToken()).toBeNull()

    trigger401()

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it.each([
    'http://localhost:8000/v1/api/auth/sign-in/email-otp',
    'http://localhost:8000/v1/api/auth/passkey/verify-authentication',
  ])('keeps a stored token when a sign-in attempt is rejected with 401 (%s)', (url) => {
    setAuthToken('valid-token')
    const options = buildFetchOptions('web')

    options.onError({
      response: new Response(null, { status: 401 }),
      request: { url, headers: new Headers({ Authorization: `Bearer ${getAuthToken()}` }) },
    })

    expect(getAuthToken()).toBe('valid-token')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('still treats a 401 from any other route as an expired session', () => {
    setAuthToken('stale-token')
    const options = buildFetchOptions('web')

    options.onError({
      response: new Response(null, { status: 401 }),
      request: {
        url: 'http://localhost:8000/v1/api/auth/get-session',
        headers: new Headers({ Authorization: `Bearer ${getAuthToken()}` }),
      },
    })

    expect(getAuthToken()).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch on non-401 responses', () => {
    setAuthToken('valid-token')
    const options = buildFetchOptions('web')

    options.onError({
      request: { headers: new Headers(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}) },
      response: new Response(null, { status: 500 }),
    })

    expect(getAuthToken()).toBe('valid-token')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('dispatches app_version_unsupported on a 426 without clearing the token', () => {
    setAuthToken('valid-token')
    const options = buildFetchOptions('web')

    options.onError({
      request: { headers: new Headers(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}) },
      response: new Response(null, { status: 426 }),
    })

    // A version block is not a session-expiry — the token stays put.
    expect(getAuthToken()).toBe('valid-token')
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('app_version_unsupported')
  })

  it('clears the cached session on 401 so a future offline boot does not show stale data', () => {
    setAuthToken('stale-token')
    setCachedSession({ user: { id: '1' }, session: { id: 's1' } })

    trigger401()

    expect(localStorage.getItem(sessionCacheKey)).toBeNull()
    expect(getCachedSession()).toBeNull()
  })

  it('clears the cached session on 401 even when no token was stored', () => {
    setCachedSession({ user: { id: '1' } })

    trigger401()

    expect(getCachedSession()).toBeNull()
  })
})

describe('auth client server isolation', () => {
  const firstServer = 'https://first.example/v1'
  const nextServer = 'https://next.example/v1'
  const originalSettings = useLocalSettingsStore.getState()

  beforeEach(() => {
    clearAuthToken()
    clearCachedSession()
    useLocalSettingsStore.setState({ cloudUrl: firstServer, serverHasAuthenticated: false })
  })

  afterEach(() => {
    clearAuthToken()
    clearCachedSession()
    useLocalSettingsStore.setState(originalSettings)
  })

  it('does not expose the current token to an obsolete auth client', () => {
    const options = buildFetchOptions('web')
    useLocalSettingsStore.setState({ cloudUrl: nextServer })
    setAuthToken('next-server-token')

    expect(options.auth.token()).toBe('')
    expect(() => options.onRequest({ headers: new Headers() })).toThrow('The selected server changed')
  })

  it('rejects stale-tab credentials and callbacks before the settings event is delivered', () => {
    const options = buildFetchOptions('web')
    const settings = useLocalSettingsStore.getState()
    localStorage.setItem('thunderbolt-local-settings', JSON.stringify({ state: { ...settings, cloudUrl: nextServer } }))
    localStorage.setItem(authTokenKey, JSON.stringify({ token: 'next-token', cloudUrl: nextServer }))

    expect(options.auth.token()).toBe('')
    expect(() => options.onRequest({ headers: new Headers() })).toThrow('The selected server changed')
    expect(() =>
      options.onSuccess({
        response: Response.json({}, { headers: { 'set-auth-token': 'old-token' } }),
        request: { headers: new Headers() },
      }),
    ).toThrow('Auth session changed')
    expect(() =>
      options.onError({ response: new Response(null, { status: 401 }), request: { headers: new Headers() } }),
    ).toThrow('Auth session changed')
    expect(JSON.parse(localStorage.getItem(authTokenKey)!)).toEqual({ token: 'next-token', cloudUrl: nextServer })
  })

  it('rejects a late sign-in result without replacing the current token', async () => {
    const client = createAuthClientInstance(firstServer)
    const response = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    const request = client.$fetch('/sign-in/email-otp', {
      method: 'POST',
      body: { email: 'user@example.com', otp: '123456' },
      customFetchImpl: async () => {
        started.resolve()
        return response.promise
      },
    })
    const failure = request.catch((error: unknown) => error)
    await started.promise
    useLocalSettingsStore.setState({ cloudUrl: nextServer })
    setAuthToken('next-server-token')
    response.resolve(Response.json({ user: { id: 'old-user' } }, { headers: { 'set-auth-token': 'old-token' } }))

    expect(await failure).toMatchObject({ name: 'AbortError' })
    expect(getAuthToken()).toBe('next-server-token')
    expect(getCachedSession()).toBeNull()
  })

  it.each([401, 426])('ignores a late %s from the previous server', (status) => {
    const options = buildFetchOptions('web')
    useLocalSettingsStore.setState({ cloudUrl: nextServer })
    setAuthToken('next-server-token')
    const onInvalid = mock(() => {})
    window.addEventListener('powersync_credentials_invalid', onInvalid)
    window.addEventListener('app_version_unsupported', onInvalid)
    try {
      expect(() =>
        options.onError({ response: new Response(null, { status }), request: { headers: new Headers() } }),
      ).toThrow('Auth session changed')
      expect(getAuthToken()).toBe('next-server-token')
      expect(onInvalid).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('powersync_credentials_invalid', onInvalid)
      window.removeEventListener('app_version_unsupported', onInvalid)
    }
  })
})

describe('hydrateSessionFromCache', () => {
  type AtomState = { data: unknown; isPending: boolean }

  const createFakeAtom = (initial: AtomState = { data: null, isPending: true }) => {
    let state: AtomState = initial
    return {
      get: () => state,
      set: (next: AtomState) => {
        state = next
      },
    }
  }

  const createFakeClient = (atom: ReturnType<typeof createFakeAtom>) =>
    ({
      $store: { atoms: { session: atom } },
    }) as unknown as ReturnType<typeof createAuthClient>

  const future = () => new Date(Date.now() + 60_000).toISOString()
  const past = () => new Date(Date.now() - 60_000).toISOString()

  beforeEach(() => {
    clearAuthToken()
    clearCachedSession()
  })

  afterEach(() => {
    clearAuthToken()
    clearCachedSession()
  })

  it('seeds the atom when token and non-expired cache are present', () => {
    setAuthToken('t')
    const cached = { user: { id: 'u1' }, session: { id: 's1', token: 't', expiresAt: future() } }
    setCachedSession(cached)
    const atom = createFakeAtom()

    hydrateSessionFromCache(createFakeClient(atom))

    expect(atom.get().data).toEqual(cached)
    expect(atom.get().isPending).toBe(false)
  })

  it.each(['raw-token.signature', 'raw-token.signature%2B%2F%3D'])(
    'hydrates a raw session token stored with signed bearer %s',
    (bearer) => {
      setAuthToken(bearer)
      const cached = { user: { id: 'u1' }, session: { token: 'raw-token', expiresAt: future() } }
      setCachedSession(cached)
      const atom = createFakeAtom()
      hydrateSessionFromCache(createFakeClient(atom))
      expect(atom.get().data).toEqual(cached)
    },
  )

  it.each([true, false])('hydrates cookie-only SSO only while the cache is valid: %s', (valid) => {
    const env = import.meta.env as Record<string, unknown>
    const previousMode = env.VITE_AUTH_MODE
    env.VITE_AUTH_MODE = 'sso'
    try {
      const cached = {
        user: { id: 'sso-user' },
        session: { token: 'cookie-session', expiresAt: valid ? future() : past() },
      }
      setCachedSession(cached)
      const atom = createFakeAtom()
      hydrateSessionFromCache(createFakeClient(atom))
      expect(atom.get().data).toEqual(valid ? cached : null)
    } finally {
      if (previousMode === undefined) {
        delete env.VITE_AUTH_MODE
      } else {
        env.VITE_AUTH_MODE = previousMode
      }
    }
  })

  it('does not seed an older account’s cache under a new token', () => {
    setAuthToken('new')
    setCachedSession({ user: { id: 'old' }, session: { token: 'old', expiresAt: future() } })
    const atom = createFakeAtom()
    hydrateSessionFromCache(createFakeClient(atom))
    expect(atom.get().data).toBeNull()
    expect(getCachedSession()).toBeNull()
  })

  it('does not seed when no token is stored', () => {
    setCachedSession({ user: { id: 'u1' }, session: { expiresAt: future() } })
    const atom = createFakeAtom()

    hydrateSessionFromCache(createFakeClient(atom))

    expect(atom.get().data).toBeNull()
    expect(atom.get().isPending).toBe(true)
  })

  it('does not seed when the cache is empty', () => {
    setAuthToken('t')
    const atom = createFakeAtom()

    hydrateSessionFromCache(createFakeClient(atom))

    expect(atom.get().data).toBeNull()
    expect(atom.get().isPending).toBe(true)
  })

  it('drops and clears expired caches without seeding', () => {
    setAuthToken('t')
    setCachedSession({ user: { id: 'u1' }, session: { token: 't', expiresAt: past() } })
    const atom = createFakeAtom()

    hydrateSessionFromCache(createFakeClient(atom))

    expect(atom.get().data).toBeNull()
    expect(getCachedSession()).toBeNull()
  })
})

describe('subscribeSessionCachePersist', () => {
  type AtomState = { data: unknown; isPending?: boolean; isRefetching?: boolean; error?: unknown }
  type Listener = (state: AtomState) => void

  const createFakeSubscribableAtom = () => {
    const listeners = new Set<Listener>()
    return {
      emit: (state: AtomState) => {
        listeners.forEach((l) => l(state))
      },
      subscribe: (l: Listener) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      size: () => listeners.size,
    }
  }

  const createFakeClient = (atom: ReturnType<typeof createFakeSubscribableAtom>) =>
    ({
      $store: { atoms: { session: atom } },
    }) as unknown as ReturnType<typeof createAuthClient>

  beforeEach(() => {
    clearCachedSession()
  })

  afterEach(() => {
    clearCachedSession()
  })

  it('persists payloads that carry the current user and session', () => {
    setAuthToken('current')
    const atom = createFakeSubscribableAtom()
    subscribeSessionCachePersist(createFakeClient(atom))

    const payload = { user: { id: 'u1' }, session: { id: 's1', token: 'current', expiresAt: new Date().toISOString() } }
    atom.emit({ data: payload })

    expect(getCachedSession()).toEqual(payload)
  })

  it('permanently binds the selected server after its first successful session', () => {
    useLocalSettingsStore.setState({
      cloudUrl: 'https://chosen.example/v1',
      localMode: true,
      serverHasAuthenticated: false,
    })
    setAuthToken('current')
    useLocalSettingsStore.setState({ serverHasAuthenticated: false })
    const atom = createFakeSubscribableAtom()
    subscribeSessionCachePersist(createFakeClient(atom))

    atom.emit({ data: { user: { id: 'u1' }, session: { id: 's1', token: 'current' } } })
    clearCachedSession()
    atom.emit({ data: null })

    expect(useLocalSettingsStore.getState().serverHasAuthenticated).toBe(true)
  })
  it('persists the raw session token correlated with a URI-encoded signed bearer', () => {
    setAuthToken('raw-token.signature%2F%2B%3D')
    const atom = createFakeSubscribableAtom()
    const unsubscribe = subscribeSessionCachePersist(createFakeClient(atom))
    const payload = { user: { id: 'u1' }, session: { token: 'raw-token', expiresAt: new Date().toISOString() } }
    atom.emit({ data: payload })
    expect(getCachedSession()).toEqual(payload)
    unsubscribe()
  })

  it('persists a cookie-only SSO session without inventing a bearer token', () => {
    const env = import.meta.env as Record<string, unknown>
    const previousMode = env.VITE_AUTH_MODE
    env.VITE_AUTH_MODE = 'sso'
    clearAuthToken()
    const atom = createFakeSubscribableAtom()
    const unsubscribe = subscribeSessionCachePersist(createFakeClient(atom))
    try {
      const payload = { user: { id: 'u1' }, session: { token: 'cookie-session' } }
      atom.emit({ data: payload })
      expect(getCachedSession()).toEqual(payload)
      expect(getAuthToken()).toBeNull()
    } finally {
      unsubscribe()
      if (previousMode === undefined) {
        delete env.VITE_AUTH_MODE
      } else {
        env.VITE_AUTH_MODE = previousMode
      }
    }
  })

  it('ignores a stale session payload after sign-in changes identity', () => {
    setAuthToken('new')
    const atom = createFakeSubscribableAtom()
    const unsubscribe = subscribeSessionCachePersist(createFakeClient(atom))
    atom.emit({ data: { user: { id: 'old' }, session: { token: 'old' } } })
    expect(getCachedSession()).toBeNull()
    unsubscribe()
  })

  it('does not persist when data is null (initial / signed-out state)', () => {
    const atom = createFakeSubscribableAtom()
    subscribeSessionCachePersist(createFakeClient(atom))

    atom.emit({ data: null })

    expect(getCachedSession()).toBeNull()
  })

  it('does not persist when user or session are null (empty payload)', () => {
    const atom = createFakeSubscribableAtom()
    subscribeSessionCachePersist(createFakeClient(atom))

    atom.emit({ data: { user: null, session: null } })

    expect(getCachedSession()).toBeNull()
  })

  it.each([null, { user: null, session: null }])(
    'clears cached authentication after a successful signed-out response: %j',
    (data) => {
      const atom = createFakeSubscribableAtom()
      subscribeSessionCachePersist(createFakeClient(atom))
      setCachedSession({ user: { id: 'u1' }, session: { expiresAt: new Date(Date.now() + 60_000) } })
      atom.emit({ data, isPending: false, isRefetching: false, error: null })
      expect(getCachedSession()).toBeNull()
    },
  )

  it.each([
    { isPending: true, isRefetching: false, error: null },
    { isPending: false, isRefetching: true, error: null },
    { isPending: false, isRefetching: false, error: new Error('Offline') },
  ])('preserves offline authentication during an inconclusive session check: %j', (state) => {
    const atom = createFakeSubscribableAtom()
    subscribeSessionCachePersist(createFakeClient(atom))
    const payload = { user: { id: 'u1' }, session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }
    setCachedSession(payload)
    atom.emit({ data: null, ...state })
    expect(getCachedSession()).toEqual(payload)
  })

  it('unsubscribe stops further writes to the cache', () => {
    const atom = createFakeSubscribableAtom()
    const unsubscribe = subscribeSessionCachePersist(createFakeClient(atom))
    expect(atom.size()).toBe(1)

    unsubscribe()
    expect(atom.size()).toBe(0)

    atom.emit({ data: { user: { id: 'u1' }, session: { id: 's1' } } })
    expect(getCachedSession()).toBeNull()
  })

  it('ignores old session emissions before React cleans up the previous subscription', () => {
    const settings = useLocalSettingsStore.getState()
    useLocalSettingsStore.setState({ cloudUrl: 'https://old.example/v1', serverHasAuthenticated: false })
    const atom = createFakeSubscribableAtom()
    const unsubscribe = subscribeSessionCachePersist(createFakeClient(atom))
    useLocalSettingsStore.setState({ cloudUrl: 'https://new.example/v1' })
    try {
      atom.emit({ data: { user: { id: 'old-user' }, session: { id: 'old-session' } } })
      expect(getCachedSession()).toBeNull()
      expect(useLocalSettingsStore.getState().serverHasAuthenticated).toBe(false)
    } finally {
      unsubscribe()
      useLocalSettingsStore.setState(settings)
    }
  })
})

describe('AuthProvider — cross-tab auth-token listener', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  let reloadSpy: ReturnType<typeof mock>
  let capturedEvents: CustomEvent[] = []
  const originalReload = window.location.reload

  const handleCapturedEvent = (e: Event) => {
    capturedEvents.push(e as CustomEvent)
  }

  beforeEach(() => {
    capturedEvents = []
    reloadSpy = mock(() => {})
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: reloadSpy,
    })
    window.addEventListener(powersyncCredentialsInvalid, handleCapturedEvent)
    clearAuthToken()
  })

  afterEach(() => {
    window.removeEventListener(powersyncCredentialsInvalid, handleCapturedEvent)
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: originalReload,
    })
    cleanup()
    clearAuthToken()
  })

  const renderAuthProvider = () => {
    const authClient = createMockAuthClient({ session: null })
    const TestProvider = createTestProvider({ authClient })
    return render(null, { wrapper: TestProvider })
  }

  it('reloads when another tab rotates the token (newValue truthy and different)', () => {
    renderAuthProvider()

    fireStorageEvent('new-token', 'old-token')

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(capturedEvents).toHaveLength(0)
  })

  it('clears the cached session before reloading on cross-tab token rotation', () => {
    setCachedSession({ user: { id: 'u1' }, session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } })
    renderAuthProvider()

    fireStorageEvent('new-token', 'old-token')

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(getCachedSession()).toBeNull()
  })

  it('dispatches session_expired when another tab clears the token', () => {
    renderAuthProvider()

    fireStorageEvent(null, 'old-token')

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(capturedEvents).toHaveLength(1)
    expect(capturedEvents[0].type).toBe(powersyncCredentialsInvalid)
    expect(capturedEvents[0].detail).toEqual({ reason: 'session_expired' })
  })
})

describe('Better Auth response ownership', () => {
  const request = (token: string | null) => ({
    url: 'https://api.example.com/v1/api/auth/get-session',
    headers: new Headers(token ? { Authorization: `Bearer ${token}` } : {}),
  })

  it('does not clear a newer token or its cache on an old request’s 401', () => {
    const options = buildFetchOptions('web')
    const previous = request('old')
    setAuthToken('new')
    setCachedSession({ user: { id: 'new-user' } })
    expect(() => options.onError({ request: previous, response: new Response(null, { status: 401 }) })).toThrow(
      'Auth session changed',
    )
    expect(getAuthToken()).toBe('new')
    expect(getCachedSession()?.user?.id).toBe('new-user')
    clearCachedSession()
  })

  it.each(['new', null])('does not resurrect an old session after credentials change to %s', (token) => {
    const options = buildFetchOptions('web')
    if (token) {
      setAuthToken(token)
    } else {
      clearAuthToken()
    }
    expect(() =>
      options.onSuccess({
        request: request('old'),
        response: new Response(null, { headers: { 'set-auth-token': 'late' } }),
      }),
    ).toThrow('Auth session changed')
    expect(getAuthToken()).toBe(token)
  })

  it('accepts a token for the current sign-in and ignores an aborted completion', () => {
    clearAuthToken()
    const options = buildFetchOptions('web')
    options.onSuccess({
      request: request(null),
      response: new Response(null, { headers: { 'set-auth-token': 'new' } }),
    })
    expect(getAuthToken()).toBe('new')
    expect(() =>
      options.onSuccess({
        request: { ...request('new'), signal: AbortSignal.abort() },
        response: new Response(null, { headers: { 'set-auth-token': 'aborted' } }),
      }),
    ).toThrow('Auth session changed')
    expect(getAuthToken()).toBe('new')
  })
})

describe('Better Auth session atom ownership', () => {
  afterEach(() => {
    clearAuthToken()
    clearCachedSession()
  })

  it.each([
    { status: 200, cookieOnly: false },
    { status: 401, cookieOnly: false },
    { status: 200, cookieOnly: true },
    { status: 401, cookieOnly: true },
  ])('does not publish an old response into the real session atom (%p)', async ({ status, cookieOnly }) => {
    const env = import.meta.env as Record<string, unknown>
    const previousMode = env.VITE_AUTH_MODE
    if (cookieOnly) {
      env.VITE_AUTH_MODE = 'sso'
      clearAuthToken()
    } else {
      setAuthToken('old.signature')
    }
    const pending = Promise.withResolvers<Response>()
    const client = createAuthClient({
      baseURL: 'https://api.example.test',
      fetchOptions: {
        ...buildFetchOptions('web'),
        customFetchImpl: Object.assign(() => pending.promise, { preconnect: () => {} }),
      },
    })
    const atom = client.$store.atoms.session
    const unsubscribe = atom.subscribe(() => {})
    try {
      await getClock().tickAsync(0)
      if (cookieOnly) {
        invalidateAuthRequests()
      } else {
        setAuthToken('new.signature')
      }
      const current = { user: { id: 'new-user' }, session: { token: 'new' } }
      atom.set({ ...atom.get(), data: current, isPending: false })
      pending.resolve(Response.json({ user: { id: 'old-user' }, session: { token: 'old' } }, { status }))
      await getClock().tickAsync(0)
      expect(atom.get().data).toEqual(current)
      expect(getAuthToken()).toBe(cookieOnly ? null : 'new.signature')
    } finally {
      unsubscribe()
      if (previousMode === undefined) {
        delete env.VITE_AUTH_MODE
      } else {
        env.VITE_AUTH_MODE = previousMode
      }
    }
  })

  it('does not cancel a valid sign-in when a concurrent unauthenticated session probe returns 401', async () => {
    clearAuthToken()
    clearCachedSession()
    const validation = Promise.withResolvers<Response>()
    const login = Promise.withResolvers<Response>()
    const client = createAuthClient({
      baseURL: 'https://api.example.test',
      fetchOptions: {
        ...buildFetchOptions('web'),
        customFetchImpl: Object.assign(
          (input: string | URL | Request) =>
            String(input).endsWith('/get-session') ? validation.promise : login.promise,
          { preconnect: () => {} },
        ),
      },
    })
    const checking = client.$fetch('/get-session')
    const signingIn = client.$fetch('/sign-in/email-otp', { method: 'POST' })
    await getClock().tickAsync(0)
    validation.resolve(Response.json({ message: 'No session' }, { status: 401 }))
    await checking
    login.resolve(Response.json({ user: { id: 'signed-in' } }, { headers: { 'set-auth-token': 'new.signature' } }))
    expect((await signingIn).error).toBeNull()
    expect(getAuthToken()).toBe('new.signature')
  })

  it('rejects a cookie-only response after cleanup starts before publishing credentials', () => {
    clearAuthToken()
    const options = buildFetchOptions('web')
    const request = { headers: new Headers() }
    options.onRequest(request)
    options.onResponse({ request, response: new Response(null) })
    invalidateAuthRequests()
    expect(() =>
      options.onSuccess({ request, response: new Response(null, { headers: { 'set-auth-token': 'old.signature' } }) }),
    ).toThrow('Auth session changed')
    expect(getAuthToken()).toBeNull()
  })
})
