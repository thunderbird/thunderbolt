/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts/database-context'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getDb, isDbRegistered } from '@/db/database'
import type { FetchFn } from '@/lib/proxy-fetch'
import { ProxyFetchProvider } from '@/lib/proxy-fetch-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createMockHttpClient } from './http-client'
import { PowerSyncMockProvider } from './powersync-mock'

const mockProxyFetch = (async () => new Response()) as unknown as FetchFn

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
  /** Override the proxy fetch so hooks that fetch through the universal proxy
   *  can assert on a mocked response. Defaults to a no-op empty `Response`. */
  proxyFetch?: FetchFn
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

  const mockHttpClient = createMockHttpClient()
  const proxyFetch = options?.proxyFetch ?? mockProxyFetch

  const Wrapper = ({ children }: { children: ReactNode }) => {
    const inner = (
      <HttpClientProvider httpClient={mockHttpClient}>
        <PowerSyncMockProvider>
          <QueryClientProvider client={queryClient}>
            <ProxyFetchProvider proxyFetch={proxyFetch}>{children}</ProxyFetchProvider>
          </QueryClientProvider>
        </PowerSyncMockProvider>
      </HttpClientProvider>
    )
    if (isDbRegistered()) {
      return <DatabaseProvider db={getDb()}>{inner}</DatabaseProvider>
    }
    return inner
  }
  // Expose the client so tests can drive explicit refetch/invalidation when the
  // global fake-timer setup makes automatic refetch-on-mount timing unreliable.
  return Object.assign(Wrapper, { queryClient })
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
