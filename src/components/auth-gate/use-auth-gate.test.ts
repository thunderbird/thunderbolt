import type { AuthClient } from '@/contexts'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useAuthGate } from './use-auth-gate'

const sessionWithUser = {
  user: { id: '1', email: 'u@example.com', name: 'User' },
}

describe('useAuthGate', () => {
  describe('initial load (pending, no cached result)', () => {
    it('returns loading when session is pending and require is authenticated', () => {
      const authClient = createMockAuthClient({ session: null, isPending: true })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'loading' })
    })

    it('returns loading when session is pending and require is unauthenticated', () => {
      const authClient = createMockAuthClient({ session: null, isPending: true })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'loading' })
    })
  })

  describe('after resolve', () => {
    it('returns allowed when require authenticated and user has session', () => {
      const authClient = createMockAuthClient({ session: sessionWithUser, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns redirect when require authenticated and no session', () => {
      const authClient = createMockAuthClient({ session: null, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('authenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns allowed when require unauthenticated and no session', () => {
      const authClient = createMockAuthClient({ session: null, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns redirect when require unauthenticated and user has session', () => {
      const authClient = createMockAuthClient({ session: sessionWithUser, isPending: false })
      const wrapper = createTestProvider({ authClient })
      const { result } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })
      expect(result.current).toEqual({ status: 'redirect' })
    })
  })

  describe('refetch (pending again after resolve)', () => {
    it('returns cached allowed when require authenticated, had session, then goes pending again', () => {
      const sessionRef = { current: sessionWithUser as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })

    it('returns cached redirect when require authenticated, had no session, then goes pending again', () => {
      const sessionRef = { current: null as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'redirect' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns cached allowed when require unauthenticated, had no session, then goes pending again', () => {
      const sessionRef = { current: null as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('unauthenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      isPendingRef.current = true
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })
  })

  describe('auth state changes after resolve', () => {
    it('returns redirect when user logs out in another tab (session becomes null, isPending false)', () => {
      const sessionRef = { current: sessionWithUser as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'allowed' })

      sessionRef.current = null
      rerender()
      expect(result.current).toEqual({ status: 'redirect' })
    })

    it('returns allowed when user logs in in another tab (session appears, isPending false)', () => {
      const sessionRef = { current: null as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
      const wrapper = createTestProvider({ authClient })
      const { result, rerender } = renderHook(() => useAuthGate('authenticated'), { wrapper })

      expect(result.current).toEqual({ status: 'redirect' })

      sessionRef.current = sessionWithUser
      rerender()
      expect(result.current).toEqual({ status: 'allowed' })
    })
  })

  describe('refetch completes with different auth state', () => {
    it('updates cache to redirect when refetch completes with session expired (was allowed)', () => {
      const sessionRef = { current: sessionWithUser as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
      const sessionRef = { current: null as typeof sessionWithUser | null }
      const isPendingRef = { current: false }
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
