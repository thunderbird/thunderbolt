import { DatabaseProvider } from '@/contexts/database-context'
import { getDb, isDbRegistered } from '@/db/database'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { PowerSyncMockProvider } from './powersync-mock'

/**
 * Creates a test wrapper with React Query client, PowerSync mock, and DatabaseProvider (when available)
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

  return ({ children }: { children: ReactNode }) => {
    const inner = (
      <PowerSyncMockProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </PowerSyncMockProvider>
    )
    if (isDbRegistered()) {
      return <DatabaseProvider db={getDb()}>{inner}</DatabaseProvider>
    }
    return inner
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
