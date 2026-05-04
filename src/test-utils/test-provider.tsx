/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, DatabaseProvider, HttpClientProvider, type AuthClient, type HttpClient } from '@/contexts'
import { getDb } from '@/db/database'
import { mediaJwtQueryKey } from '@/lib/use-media-jwt'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { createMockAuthClient } from './auth-client'
import { createMockHttpClient } from './http-client'
import { PowerSyncMockProvider } from './powersync-mock'

/** Default JWT shipped with `createTestProvider()` so any component that calls
 *  `useProxyUrl()` resolves a URL synchronously. Tests that want to assert the
 *  loading branch can pass `mediaJwt: null` explicitly. */
export const testMediaJwt = 'test-media-jwt'

type TestProviderOptions = {
  mockResponse?: unknown
  authClient?: AuthClient
  httpClient?: HttpClient
  /** Pre-populate the media JWT React Query cache. Defaults to `testMediaJwt`
   *  so `useProxyUrl()` returns a URL synchronously in tests. Pass `null` to
   *  exercise the loading/null branch. */
  mediaJwt?: string | null
  queryOptions?: {
    defaultOptions?: {
      queries?: {
        retry?: boolean | number
        gcTime?: number
        staleTime?: number
      }
    }
  }
}

/**
 * Creates a comprehensive test provider that wraps the React hierarchy with all necessary contexts for testing.
 * This includes DatabaseProvider, PowerSync mock, React Query, and HTTP Client providers with test-friendly defaults.
 * Requires setupTestDatabase() to have been called before use.
 *
 * @param options - Configuration options for the test provider
 * @param options.mockResponse - Mock response data for the HTTP client (defaults to empty array)
 * @param options.queryOptions - React Query configuration options
 *
 * @example
 * ```tsx
 * const { result } = renderHook(() => useMyHook(), {
 *   wrapper: createTestProvider()
 * })
 * ```
 *
 * @example
 * ```tsx
 * render(<MyComponent />, {
 *   wrapper: createTestProvider({ mockResponse: mockData })
 * })
 * ```
 */
export const createTestProvider = (options?: TestProviderOptions) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        ...options?.queryOptions?.defaultOptions?.queries,
      },
    },
  })

  const mockHttpClient = options?.httpClient ?? createMockHttpClient(options?.mockResponse ?? [])

  const mockAuthClient = options?.authClient ?? createMockAuthClient()

  // Pre-populate the media JWT cache so any component that calls useProxyUrl()
  // resolves a URL synchronously. Pass `mediaJwt: null` to exercise the
  // loading-branch path explicitly.
  const mediaJwt = options?.mediaJwt === undefined ? testMediaJwt : options.mediaJwt
  if (mediaJwt !== null) {
    queryClient.setQueryData(mediaJwtQueryKey, mediaJwt)
  }

  return ({ children }: { children: ReactNode }) => {
    return (
      <DatabaseProvider db={getDb()}>
        <PowerSyncMockProvider>
          <QueryClientProvider client={queryClient}>
            <HttpClientProvider httpClient={mockHttpClient}>
              <AuthProvider authClient={mockAuthClient}>{children}</AuthProvider>
            </HttpClientProvider>
          </QueryClientProvider>
        </PowerSyncMockProvider>
      </DatabaseProvider>
    )
  }
}

/**
 * Creates a test provider with realistic caching behavior.
 * Useful for testing caching behavior specifically.
 *
 * @example
 * ```tsx
 * const { result } = renderHook(() => useMyHook(), {
 *   wrapper: createTestProviderWithCache()
 * })
 * ```
 */
export const createTestProviderWithCache = (options?: { mockResponse?: unknown }) => {
  return createTestProvider({
    mockResponse: options?.mockResponse,
    queryOptions: {
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 5 * 60 * 1000, // 5 minutes
          staleTime: 1 * 60 * 1000, // 1 minute
        },
      },
    },
  })
}
