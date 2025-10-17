import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
/**
 * Creates a test wrapper with React Query client
 * Useful for testing hooks that use React Query
 */
export const createQueryTestWrapper = (options?: {
  defaultOptions?: {
    queries?: {
      retry?: boolean | number
      gcTime?: number
      staleTime?: number
    }
  }
}) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        ...options?.defaultOptions?.queries,
      },
    },
  })

  return ({ children }: { children: React.ReactNode }) => {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

/**
 * Creates a test wrapper with React Query client that has realistic caching
 * Useful for testing caching behavior
 */
export const createQueryTestWrapperWithCache = () => {
  return createQueryTestWrapper({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 5 * 60 * 1000, // 5 minutes
        staleTime: 1 * 60 * 1000, // 1 minute
      },
    },
  })
}
