/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { createTestProvider } from '@/test-utils/test-provider'
import { mediaJwtQueryKey, useMediaJwt } from './use-media-jwt'

describe('useMediaJwt', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })
  afterAll(async () => {
    await teardownTestDatabase()
  })
  afterEach(async () => {
    await resetTestDatabase()
  })

  it('mints the JWT via POST /api/auth/token and returns it', async () => {
    const { httpClient, fetchSpy } = createSpyHttpClient(async () => jsonResponse({ token: 'minted-jwt' }))

    const { result } = renderHook(() => useMediaJwt(), {
      // Bypass the default `TEST_MEDIA_JWT` pre-populated in createTestProvider —
      // we want to observe the actual mint flow.
      wrapper: createTestProvider({ httpClient, mediaJwt: null }),
    })

    // Drain microtasks under fake timers so the React Query subscription resolves.
    await act(async () => {
      await getClock().runAllAsync()
    })
    await waitFor(() => expect(result.current).toBe('minted-jwt'))
    // Endpoint is the custom POST mint route mounted under /api/auth (replaces
    // Better Auth's GET /token to remove the bookmarkable/CSRF-burnable surface).
    const calls = fetchSpy.mock.calls.map((c) => c[0] as Request)
    const mintCall = calls.find((req) => req.url.endsWith('/api/auth/token'))
    expect(mintCall).toBeDefined()
    expect(mintCall!.method).toBe('POST')
  })

  it('returns null until the first mint resolves', () => {
    const { httpClient } = createSpyHttpClient(async () => {
      // Never resolve — we want to observe the loading branch.
      return new Promise<Response>(() => {}) as unknown as Response
    })

    const { result } = renderHook(() => useMediaJwt(), {
      wrapper: createTestProvider({ httpClient, mediaJwt: null }),
    })

    expect(result.current).toBeNull()
  })

  it('uses the pre-populated cache when the test provider seeds a JWT', () => {
    const { result } = renderHook(() => useMediaJwt(), {
      wrapper: createTestProvider({ mediaJwt: 'seeded-token' }),
    })
    expect(result.current).toBe('seeded-token')
  })

  it('exports a stable query key for cache pre-population', () => {
    expect(mediaJwtQueryKey).toEqual(['media-jwt'])
  })

  // ---------------------------------------------------------------------------
  // Mid-page JWT refresh — guards the headline UX claim.
  //
  // When the cached JWT becomes unusable mid-page (token reaching expiry, or
  // an upstream 401 caused by edge clock drift), invalidating the query MUST
  // trigger a refetch and the next consumer call MUST receive the fresh
  // token. Without this, every existing image baked with the old token would
  // stay broken until the staleTime tick.
  //
  // The architectural mechanism is: `queryClient.invalidateQueries` →
  // re-run `queryFn` → next subscriber re-renders with the new value.
  // ---------------------------------------------------------------------------

  it('refetches on cache invalidation and the next render returns the new JWT', async () => {
    let mintCount = 0
    const { httpClient, fetchSpy } = createSpyHttpClient(async () => {
      mintCount += 1
      return jsonResponse({ token: `jwt-${mintCount}` })
    })

    // Render both `useMediaJwt` and `useQueryClient` so the test can drive an
    // invalidation from inside the same provider tree the hook subscribes to.
    const { result } = renderHook(
      () => {
        const jwt = useMediaJwt()
        const qc = useQueryClient()
        return { jwt, qc }
      },
      {
        wrapper: createTestProvider({ httpClient, mediaJwt: null }),
      },
    )

    // First mint resolves to jwt-1.
    await act(async () => {
      await getClock().runAllAsync()
    })
    await waitFor(() => expect(result.current.jwt).toBe('jwt-1'))
    expect(mintCount).toBe(1)

    // Simulate the mid-page expiry signal: invalidate the cache. In production
    // this would be triggered by a 401 handler on the proxy fetch path or by
    // staleTime expiry; the architectural contract is the same — stale data
    // forces the next subscriber render to re-mint.
    await act(async () => {
      await result.current.qc.invalidateQueries({ queryKey: mediaJwtQueryKey })
      await getClock().runAllAsync()
    })

    // The hook now reflects the new token without a remount.
    await waitFor(() => expect(result.current.jwt).toBe('jwt-2'))
    expect(mintCount).toBe(2)
    // Both calls hit the POST mint endpoint.
    const mintCalls = fetchSpy.mock.calls.filter((c) => (c[0] as Request).url.endsWith('/api/auth/token'))
    expect(mintCalls.length).toBe(2)
    for (const call of mintCalls) {
      expect((call[0] as Request).method).toBe('POST')
    }
  })
})
