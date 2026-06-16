/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import {
  clearAuthToken,
  clearDeviceId,
  getAuthenticatedHeaders,
  getAuthToken,
  getDeviceId,
  onAuthTokenChangedInOtherTab,
  setAuthToken,
} from './auth-token'

const testServerId = '11111111-1111-1111-1111-111111111111'
const authTokenKey = `thunderbolt_auth_token__${testServerId}`

const fireStorageEvent = (newValue: string | null, oldValue: string | null, key = authTokenKey) => {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      newValue,
      oldValue,
      storageArea: localStorage,
    }),
  )
}

beforeAll(() => {
  if (typeof localStorage === 'undefined') {
    const store: Record<string, string> = {}
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v
        },
        removeItem: (k: string) => {
          delete store[k]
        },
      },
      writable: true,
    })
  }
})

beforeEach(() => {
  // Default fixture: a single server is active. Tests that need standalone / no-active
  // override this themselves.
  useTrustDomainRegistry.setState({
    servers: { [testServerId]: { serverId: testServerId, cloudUrl: 'http://test.local' } },
    activeTrustDomain: { kind: 'server', serverId: testServerId },
  })
  clearAuthToken()
  clearDeviceId()
})

// Mirror the beforeEach cleanup so the last test's token can't leak into the
// next test file (AuthProvider's mount effect fires get-session on any token).
afterEach(() => {
  clearAuthToken()
  clearDeviceId()
})

describe('auth-token', () => {
  describe('getAuthToken', () => {
    it('returns null when no token is stored', () => {
      expect(getAuthToken()).toBeNull()
    })

    it('returns token after setAuthToken', () => {
      setAuthToken('test-token-123')
      expect(getAuthToken()).toBe('test-token-123')
    })

    it('returns null when no server is active', () => {
      useTrustDomainRegistry.setState({ activeTrustDomain: undefined })
      expect(getAuthToken()).toBeNull()
    })

    it('returns null in standalone trust domains', () => {
      useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })
      expect(getAuthToken()).toBeNull()
    })
  })

  describe('setAuthToken', () => {
    it('stores token under the active server namespace', () => {
      setAuthToken('cached-token')
      expect(localStorage.getItem(authTokenKey)).toBe('cached-token')
      expect(getAuthToken()).toBe('cached-token')
    })

    it('persists token until cleared', () => {
      setAuthToken('persisted-token')
      expect(getAuthToken()).toBe('persisted-token')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
    })

    it('is a no-op when no server is active', () => {
      useTrustDomainRegistry.setState({ activeTrustDomain: undefined })
      setAuthToken('orphan')
      expect(localStorage.getItem('thunderbolt_auth_token__undefined')).toBeNull()
      expect(getAuthToken()).toBeNull()
    })

    it('namespacing isolates tokens across servers', () => {
      const serverA = '22222222-2222-2222-2222-222222222222'
      const serverB = '33333333-3333-3333-3333-333333333333'

      useTrustDomainRegistry.setState({
        servers: {
          [serverA]: { serverId: serverA, cloudUrl: 'http://a.local' },
          [serverB]: { serverId: serverB, cloudUrl: 'http://b.local' },
        },
        activeTrustDomain: { kind: 'server', serverId: serverA },
      })
      setAuthToken('token-A')

      useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'server', serverId: serverB } })
      expect(getAuthToken()).toBeNull()
      setAuthToken('token-B')

      useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'server', serverId: serverA } })
      expect(getAuthToken()).toBe('token-A')

      useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'server', serverId: serverB } })
      expect(getAuthToken()).toBe('token-B')
    })
  })

  describe('clearAuthToken', () => {
    it('clears token', () => {
      setAuthToken('token-to-clear')
      expect(getAuthToken()).toBe('token-to-clear')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
    })

    it('clears token from localStorage', () => {
      setAuthToken('persistent-token')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
      setAuthToken('other')
      expect(getAuthToken()).toBe('other')
    })
  })

  describe('getDeviceId', () => {
    it('lazy-creates a device id under the active server namespace', () => {
      const id = getDeviceId()
      expect(id).toBeTruthy()
      expect(localStorage.getItem(`thunderbolt_device_id__${testServerId}`)).toBe(id)
    })

    it('returns an empty string when no server is active', () => {
      useTrustDomainRegistry.setState({ activeTrustDomain: undefined })
      expect(getDeviceId()).toBe('')
    })

    it('namespacing isolates device ids across servers', () => {
      const serverA = '44444444-4444-4444-4444-444444444444'
      const serverB = '55555555-5555-5555-5555-555555555555'

      useTrustDomainRegistry.setState({
        servers: {
          [serverA]: { serverId: serverA, cloudUrl: 'http://a.local' },
          [serverB]: { serverId: serverB, cloudUrl: 'http://b.local' },
        },
        activeTrustDomain: { kind: 'server', serverId: serverA },
      })
      const idA = getDeviceId()

      useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'server', serverId: serverB } })
      const idB = getDeviceId()

      expect(idA).not.toBe(idB)
      expect(localStorage.getItem(`thunderbolt_device_id__${serverA}`)).toBe(idA)
      expect(localStorage.getItem(`thunderbolt_device_id__${serverB}`)).toBe(idB)
    })
  })

  describe('getAuthenticatedHeaders', () => {
    it('returns Authorization, X-Device-ID, and X-Device-Name when token and device ID exist', () => {
      setAuthToken('my-token')
      getDeviceId() // ensure device ID is created

      const headers = getAuthenticatedHeaders()

      expect(headers['Authorization']).toBe('Bearer my-token')
      expect(headers['X-Device-ID']).toBeTruthy()
      expect(headers['X-Device-Name']).toBeTruthy()
    })

    it('returns device headers but no Authorization when no auth token', () => {
      getDeviceId() // ensure device ID is created

      const headers = getAuthenticatedHeaders()

      expect(headers['Authorization']).toBeUndefined()
      expect(headers['X-Device-ID']).toBeTruthy()
      expect(headers['X-Device-Name']).toBeTruthy()
    })

    it('returns no headers when no server is active', () => {
      useTrustDomainRegistry.setState({ activeTrustDomain: undefined })
      expect(getAuthenticatedHeaders()).toEqual({})
    })

    it('returns consistent device ID across calls', () => {
      const headers1 = getAuthenticatedHeaders()
      const headers2 = getAuthenticatedHeaders()

      expect(headers1['X-Device-ID']).toBe(headers2['X-Device-ID'])
    })
  })
})

describe('onAuthTokenChangedInOtherTab', () => {
  it('fires listener when the active server token rotates', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('new-token', 'old-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('new-token', 'old-token')
    unsub()
  })

  it('fires listener when token is cleared (sign-out from another tab)', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent(null, 'old-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null, 'old-token')
    unsub()
  })

  it('does not fire for unrelated storage keys', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('some-value', null, 'other_key')

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it('does not fire for a different server’s auth token key', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('new-token', 'old-token', 'thunderbolt_auth_token__99999999-9999-9999-9999-999999999999')

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it('does not fire when new value equals old value', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('same-token', 'same-token')

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it('stops firing after unsubscribe', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)
    unsub()

    fireStorageEvent('new-token', 'old-token')

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not fire for events from sessionStorage', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: authTokenKey,
        newValue: 'new-token',
        oldValue: 'old-token',
        storageArea: sessionStorage,
      }),
    )

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })
})
