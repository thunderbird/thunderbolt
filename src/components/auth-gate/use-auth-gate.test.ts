/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useAuthGate } from './use-auth-gate'

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

const mockTokenPresent = () => {
  localStorage.setItem('thunderbolt_auth_token', 'mock-token')
}

const mockTokenAbsent = () => {
  localStorage.removeItem('thunderbolt_auth_token')
}

const createRefreshableAuthClient = (initialSession: typeof sessionWithUser | null, initialPending: boolean) => {
  const sessionRef = { current: initialSession }
  const isPendingRef = { current: initialPending }
  const authClient = {
    ...createMockAuthClient(),
    useSession: () => ({
      data: sessionRef.current,
      isPending: isPendingRef.current,
      isRefetching: false,
      error: null,
      refetch: async () => {},
    }),
  } as AuthClient
  return { authClient, sessionRef, isPendingRef }
}

describe('useAuthGate', () => {
  describe('initial load (pending, no cached result)', () => {
    it('returns loading when session is pending, no token, and require is authenticated', () => {
      mockTokenAbsent()
      const authClient = createMockAuthClient({ session: null, isPending: true })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'loading' })
    })

    it('returns allowed when session is pending, token exists, and require is authenticated', () => {
      mockTokenPresent()
      const authClient = createMockAuthClient({ session: null, isPending: true })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns allowed when session is pending, no token, and require is unauthenticated', () => {
      mockTokenAbsent()
      const authClient = createMockAuthClient({ session: null, isPending: true })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns loading when session is pending, token exists, and require is unauthenticated (falls through to cached or loading)', () => {
      mockTokenPresent()
      const authClient = createMockAuthClient({ session: null, isPending: true })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      // No cached result yet, token present but require=unauthenticated falls through to loading
      expect(result.current).toEqual({ status: 'loading' })
    })
  })

  describe('after resolve', () => {
    it('returns allowed when require authenticated and user has session', () => {
      mockTokenAbsent()
      const authClient = createMockAuthClient({ session: sessionWithUser, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns redirect when require authenticated, no session, and no token', () => {
      mockTokenAbsent()
      const authClient = createMockAuthClient({ session: null, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns allowed when require authenticated, no session, but token exists (network error case)', () => {
      mockTokenPresent()
      const authClient = createMockAuthClient({ session: null, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns allowed when require unauthenticated, no session, and no token', () => {
      mockTokenAbsent()
      const authClient = createMockAuthClient({ session: null, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns redirect when require unauthenticated and user has session', () => {
      mockTokenAbsent()
      const authClient = createMockAuthClient({ session: sessionWithUser, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns redirect when require unauthenticated, no session, but token exists', () => {
      mockTokenPresent()
      const authClient = createMockAuthClient({ session: null, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'redirect' })
    })
  })

  describe('refetch (pending again after resolve)', () => {
    it('returns cached allowed when require authenticated, had session, then goes pending again', () => {
      mockTokenAbsent()
      const { authClient, isPendingRef } = createRefreshableAuthClient(sessionWithUser, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns cached redirect when require authenticated, had no session and no token, then goes pending again', () => {
      mockTokenAbsent()
      const { authClient, isPendingRef } = createRefreshableAuthClient(null, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'redirect' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns cached allowed when require unauthenticated, had no session, then goes pending again', () => {
      mockTokenAbsent()
      const { authClient, isPendingRef } = createRefreshableAuthClient(null, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })
  })

  describe('auth state changes after resolve', () => {
    it('returns redirect when user logs out in another tab (session becomes null, isPending false, no token)', () => {
      mockTokenAbsent()
      const { authClient, sessionRef } = createRefreshableAuthClient(sessionWithUser, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      sessionRef.current = null
      rerender()
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns allowed when user logs in in another tab (session appears, isPending false)', () => {
      mockTokenAbsent()
      const { authClient, sessionRef } = createRefreshableAuthClient(null, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'redirect' })

      sessionRef.current = sessionWithUser
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })
  })

  describe('refetch completes with different auth state', () => {
    it('updates cache to redirect when refetch completes with session expired (was allowed, no token)', () => {
      mockTokenAbsent()
      const { authClient, sessionRef, isPendingRef } = createRefreshableAuthClient(sessionWithUser, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })

      sessionRef.current = null
      isPendingRef.current = false
      rerender()
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('updates cache to allowed when refetch completes with session (was redirect)', () => {
      mockTokenAbsent()
      const { authClient, sessionRef, isPendingRef } = createRefreshableAuthClient(null, false)
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'redirect' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'redirect' })

      sessionRef.current = sessionWithUser
      isPendingRef.current = false
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })
  })
})
