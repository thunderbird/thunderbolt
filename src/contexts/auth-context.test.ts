/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import { clearCachedSession, getCachedSession, setCachedSession } from '@/lib/session-cache'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { buildFetchOptions, hydrateSessionFromCache, subscribeSessionCachePersist } from './auth-context'
import type { createAuthClient } from 'better-auth/react'

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

describe('buildFetchOptions onError', () => {
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
    clearAuthToken()
    clearCachedSession()
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
    clearAuthToken()
    clearCachedSession()
  })

  const trigger401 = () => {
    const options = buildFetchOptions('web')
    options.onError({ response: new Response(null, { status: 401 }) })
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

  it('does not dispatch on non-401 responses', () => {
    setAuthToken('valid-token')
    const options = buildFetchOptions('web')

    options.onError({ response: new Response(null, { status: 500 }) })

    expect(getAuthToken()).toBe('valid-token')
    expect(dispatchSpy).not.toHaveBeenCalled()
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
    const cached = { user: { id: 'u1' }, session: { id: 's1', expiresAt: future() } }
    setCachedSession(cached)
    const atom = createFakeAtom()

    hydrateSessionFromCache(createFakeClient(atom))

    expect(atom.get().data).toEqual(cached)
    expect(atom.get().isPending).toBe(false)
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
    setCachedSession({ user: { id: 'u1' }, session: { expiresAt: past() } })
    const atom = createFakeAtom()

    hydrateSessionFromCache(createFakeClient(atom))

    expect(atom.get().data).toBeNull()
    expect(getCachedSession()).toBeNull()
  })
})

describe('subscribeSessionCachePersist', () => {
  type Listener = (state: { data: unknown }) => void

  const createFakeSubscribableAtom = () => {
    const listeners = new Set<Listener>()
    return {
      emit: (state: { data: unknown }) => {
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

  it('persists payloads that carry both user and session', () => {
    const atom = createFakeSubscribableAtom()
    subscribeSessionCachePersist(createFakeClient(atom))

    const payload = { user: { id: 'u1' }, session: { id: 's1', expiresAt: new Date().toISOString() } }
    atom.emit({ data: payload })

    expect(getCachedSession()).toEqual(payload)
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

  it('unsubscribe stops further writes to the cache', () => {
    const atom = createFakeSubscribableAtom()
    const unsubscribe = subscribeSessionCachePersist(createFakeClient(atom))
    expect(atom.size()).toBe(1)

    unsubscribe()
    expect(atom.size()).toBe(0)

    atom.emit({ data: { user: { id: 'u1' }, session: { id: 's1' } } })
    expect(getCachedSession()).toBeNull()
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
