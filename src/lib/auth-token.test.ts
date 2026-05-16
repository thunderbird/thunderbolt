/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearAuthToken,
  clearDeviceId,
  getAuthenticatedHeaders,
  getAuthToken,
  getDeviceId,
  setAuthToken,
} from './auth-token'

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
  })

  describe('setAuthToken', () => {
    it('stores token in localStorage', () => {
      setAuthToken('cached-token')
      expect(getAuthToken()).toBe('cached-token')
    })

    it('persists token until cleared', () => {
      setAuthToken('persisted-token')
      expect(getAuthToken()).toBe('persisted-token')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
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

    it('returns consistent device ID across calls', () => {
      const headers1 = getAuthenticatedHeaders()
      const headers2 = getAuthenticatedHeaders()

      expect(headers1['X-Device-ID']).toBe(headers2['X-Device-ID'])
    })
  })
})
