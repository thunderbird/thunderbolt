import { AuthProvider, HttpClientProvider, type AuthClient } from '@/contexts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { createMockAuthClient } from './auth-client'
import { createMockHttpClient } from './http-client'

type TestProviderOptions = {
  mockResponse?: unknown
  authClient?: AuthClient
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
 * This includes React Query and HTTP Client providers with test-friendly defaults.
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

  const mockHttpClient = createMockHttpClient(options?.mockResponse ?? [])

  const mockAuthClient = options?.authClient ?? createMockAuthClient()

  return ({ children }: { children: ReactNode }) => {
    return (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider httpClient={mockHttpClient}>
          <AuthProvider authClient={mockAuthClient}>{children}</AuthProvider>
        </HttpClientProvider>
      </QueryClientProvider>
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
