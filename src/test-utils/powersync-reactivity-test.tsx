/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MemoryRouter, Route, Routes } from 'react-router'
import { act, render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { useMemo, type ReactElement, type ReactNode } from 'react'
import { HttpClientProvider } from '@/contexts'
import { mediaJwtQueryKey } from '@/lib/use-media-jwt'
import { getClock } from '@/testing-library'
import { createMockHttpClient } from './http-client'
import { PowerSyncReactivityTestProvider } from './powersync-mock'
import { testMediaJwt } from './test-provider'

/**
 * Poll for element with fake timers. Avoids waitFor's jest.advanceTimersByTime issues in Bun.
 */
export const waitForElement = async (getElement: () => HTMLElement | null, timeoutMs = 2000): Promise<HTMLElement> => {
  const clock = getClock()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const el = getElement()
      if (el) {
        return el
      }
    } catch {
      // not found yet
    }
    await act(async () => {
      clock.tick(50)
      await clock.runAllAsync()
    })
  }
  return getElement()!
}

type RenderWithReactivityOptions = RenderOptions & {
  /** Route path for MemoryRouter (e.g. '/settings/models/123') */
  route?: string
  /** Route path pattern for params (e.g. '/settings/models/:modelId'). Defaults to '*' */
  routePath?: string
  /** Table names for PowerSync reactivity (e.g. ['models']) */
  tables?: string[]
}

/**
 * Renders a component with PowerSyncReactivityTestProvider and optional MemoryRouter.
 * Returns render result plus triggerChange for reactivity tests.
 *
 * @example
 * ```tsx
 * const { getByText, triggerChange } = renderWithReactivity(<ModelDetailPage />, {
 *   route: '/settings/models/123',
 *   routePath: '/settings/models/:modelId',
 *   tables: ['models'],
 * })
 * await updateModel('123', { name: 'Updated' })
 * triggerChange(['models'])
 * await waitFor(() => expect(getByText('Updated')).toBeInTheDocument())
 * ```
 */
export const renderWithReactivity = (
  ui: ReactElement,
  options: RenderWithReactivityOptions = {},
): RenderResult & { triggerChange: (tables: string[]) => void } => {
  const { route, routePath = '*', tables = [], wrapper: InnerWrapper, ...renderOptions } = options

  const triggerChangeRef = { current: null as ((tables: string[]) => void) | null }

  const Wrapper = ({ children }: { children: ReactNode }) => {
    // Build a single QueryClient owned by `renderWithReactivity` so we can
    // seed the media-jwt cache before any subscriber renders. Without this
    // seed, components that call `useProxyUrl()` (which calls `useMediaJwt`)
    // would issue a real `httpClient.post('api/auth/token')` against the
    // mock and resolve to `undefined` on the first render — fine for
    // correctness but fires a queryFn every test for no reason. Mirrors
    // `createTestProvider`'s contract so test authors can mix the two.
    const queryClient = useMemo(() => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0, staleTime: 0 },
        },
      })
      client.setQueryData(mediaJwtQueryKey, testMediaJwt)
      return client
    }, [])

    const httpClient = useMemo(() => createMockHttpClient(), [])

    const content = route ? (
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={routePath} element={children} />
        </Routes>
      </MemoryRouter>
    ) : (
      children
    )

    return (
      <HttpClientProvider httpClient={httpClient}>
        <PowerSyncReactivityTestProvider tables={tables} triggerChangeRef={triggerChangeRef} queryClient={queryClient}>
          {InnerWrapper ? <InnerWrapper>{content}</InnerWrapper> : content}
        </PowerSyncReactivityTestProvider>
      </HttpClientProvider>
    )
  }

  const result = render(ui, {
    ...renderOptions,
    wrapper: Wrapper,
  })

  const triggerChange = (tablesToTrigger: string[]) => {
    if (!triggerChangeRef.current) {
      throw new Error('triggerChange not yet available - ensure PowerSyncReactivityTestProvider has mounted')
    }
    triggerChangeRef.current(tablesToTrigger)
  }

  return { ...result, triggerChange }
}
