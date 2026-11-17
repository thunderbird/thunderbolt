/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { createClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

export type FakeRequest = { method: string; path: string; search: URLSearchParams; body: unknown }

export type FakeReply = { status?: number; body?: unknown }

/**
 * A wrapper for admin component tests: a signed-in admin, a router, and a fake backend that records
 * each request and answers through `respond`. `queryClient` is exposed to inspect the caches.
 */
export const createAdminTestHarness = (respond: (request: FakeRequest) => FakeReply = () => ({})) => {
  const requests: FakeRequest[] = []
  const http = createClient({
    prefixUrl: 'http://backend.test/v1',
    fetch: async (input) => {
      const request = input as Request
      const url = new URL(request.url)
      const text = await request.text()
      const fake = {
        method: request.method,
        path: url.pathname.replace(/^\/v1\//, ''),
        search: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
      }
      requests.push(fake)
      const { status = 200, body = {} } = respond(fake)
      return new Response(status === 204 ? null : JSON.stringify(body), { status })
    },
  })
  const TestProvider = createTestProvider({
    httpClient: http,
    authClient: createMockAuthClient({
      session: { user: { id: 'admin-1', email: 'admin@example.com', roles: ['member', 'admin'] } },
    }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </TestProvider>
  )
  return { wrapper, requests, queryClient }
}

/** Settle pending requests and timers under the suite's fake clock. */
export const flush = () =>
  act(async () => {
    await getClock().runAllAsync()
  })
