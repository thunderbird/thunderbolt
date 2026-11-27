/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { createClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getFormatters, toDate } from '@/i18n/format'
import { getClock } from '@/testing-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

export type FakeRequest = { method: string; path: string; search: URLSearchParams; body: unknown }

export type FakeReply = { status?: number; body?: unknown }

/**
 * A wrapper for admin component tests: a signed-in admin, a router at `initialEntries`, and a fake
 * backend that records each request and answers through `respond`, which may hold a reply back.
 * `queryClient` is exposed to inspect the caches.
 */
export const createAdminTestHarness = (
  respond: (request: FakeRequest) => FakeReply | Promise<FakeReply> = () => ({}),
  { initialEntries }: { initialEntries?: ComponentProps<typeof MemoryRouter>['initialEntries'] } = {},
) => {
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
      const { status = 200, body = {} } = await respond(fake)
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
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
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

/** A day button's accessible name, which says "Today, " and ", selected" around the date when they apply. */
const dayButtonName = (day: string) =>
  new RegExp(`^(Today, )?${day.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(, selected)?$`)

/**
 * Pick `day` (`YYYY-MM-DD`) in the empty `DateField` labelled `label`: open it, page from the current
 * month to the day's month, and click the day.
 */
export const pickDate = (label: string, day: string) => {
  const formatters = getFormatters('en')
  const date = toDate(day)
  const target = formatters.monthYear(date)
  const step = date > new Date() ? 'Next month' : 'Previous month'
  fireEvent.click(screen.getByLabelText(label))
  for (let pages = 0; screen.getByRole('grid').getAttribute('aria-label') !== target; pages++) {
    if (pages > 120) {
      throw new Error(`The calendar never reached ${target}`)
    }
    fireEvent.click(screen.getByRole('button', { name: step }))
  }
  fireEvent.click(screen.getByRole('button', { name: dayButtonName(formatters.date(date)) }))
}
