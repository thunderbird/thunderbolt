/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { getSettings, getSettingsRecords, updateSettings } from '@/dal/settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import type { Setting } from '@/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import Layout from './layout'

describe('Layout sidebar preference', () => {
  const clients: QueryClient[] = []

  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    restoreViewport()
    await resetTestDatabase()
  })
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    restoreViewport()
    document.cookie = 'sidebar_state=; path=/; max-age=0'
  })

  it('renders the saved closed sidebar before its query resolves, then follows live updates and persists toggles', async () => {
    const db = getDb()
    await updateSettings(db, { sidebar_state: false })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    clients.push(client)
    const pending = Promise.withResolvers<Setting[]>()
    // Share a deliberately pending query with the real settings hook, without
    // replacing its implementation or any production module.
    const loading = client.fetchQuery({ queryKey: ['settings', 'sidebar_state'], queryFn: () => pending.promise })
    const authClient = createMockAuthClient()
    const httpClient = createMockHttpClient([])
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <HttpClientProvider httpClient={httpClient}>
          <AuthProvider authClient={authClient}>
            <SignInModalProvider>
              <MemoryRouter>{children}</MemoryRouter>
            </SignInModalProvider>
          </AuthProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    )
    const { container, triggerChange } = renderWithReactivity(
      <Routes>
        <Route path="/" element={<Layout initialSidebarOpen={false} />}>
          <Route index element={<p>Chat content</p>} />
        </Route>
      </Routes>,
      { wrapper: Wrapper, tables: ['settings'] },
    )
    const sidebar = () => container.querySelector('[data-state][data-collapsible]')

    try {
      expect(client.getQueryState(['settings', 'sidebar_state'])?.status).toBe('pending')
      expect(screen.getByText('Chat content')).toBeInTheDocument()
      expect(sidebar()).toHaveAttribute('data-state', 'collapsed')

      await act(async () => {
        pending.resolve(await getSettingsRecords(db, ['sidebar_state']))
        await loading
        await getClock().runAllAsync()
      })
      expect(sidebar()).toHaveAttribute('data-state', 'collapsed')

      await act(async () => {
        await updateSettings(db, { sidebar_state: true })
        triggerChange(['settings'])
        await getClock().runAllAsync()
      })
      expect(sidebar()).toHaveAttribute('data-state', 'expanded')

      await act(async () => {
        fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
        await getClock().runAllAsync()
      })
      expect((await getSettings(db, { sidebar_state: true })).sidebarState).toBe(false)
      await act(async () => {
        triggerChange(['settings'])
        await getClock().runAllAsync()
      })
      expect(sidebar()).toHaveAttribute('data-state', 'collapsed')
      expect(screen.getByText('Chat content')).toBeInTheDocument()
    } finally {
      pending.resolve([])
      await loading
    }
  })
})
