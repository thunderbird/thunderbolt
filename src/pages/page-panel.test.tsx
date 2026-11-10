/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DatabaseProvider } from '@/contexts/database-context'
import { PowerSyncMockProvider } from '@/test-utils/powersync-mock'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import { pageDefinitionForPin } from './page-display'
import { pageReturnPath } from './page-path'
import { usePageStore } from './page-store'
import { getSavedPagesQuery, savedPagesFromRows } from './saved-pages'
import { restoreSavedPage } from './restore-saved-page'
import { createSavedPage } from './saved-page'
import { PagePanel } from './page-panel'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(() => usePageStore.setState({ sessions: [], activeId: null }))
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
})
const Location = () => <output data-testid="location">{useLocation().pathname}</output>
const mount = (onClose = mock(() => {})) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const wrapper = ({ children }: PropsWithChildren) => (
    <DatabaseProvider db={getDb()}>
      <PowerSyncMockProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/chats/existing']}>
            {children}
            <Location />
          </MemoryRouter>
        </QueryClientProvider>
      </PowerSyncMockProvider>
    </DatabaseProvider>
  )
  return { ...render(<PagePanel onClose={onClose} />, { wrapper }), onClose }
}

it('expands the exact HTML session without mounting another renderer or creating a tab', () => {
  const id = usePageStore
    .getState()
    .ensure({ id: 'stateful', title: 'Counter', source: { kind: 'html', html: '<button>Increment</button>' } })
  const { container } = mount()
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.querySelector('[data-page-slot]')).toHaveAttribute('data-page-slot', id)
  const controls = screen.getByRole('button', { name: 'Select element on page' }).parentElement!
  expect(controls.children[1]).toHaveAttribute('aria-label', 'Expand page')
  fireEvent.click(screen.getByRole('button', { name: 'Expand page' }))
  expect(screen.getByTestId('location')).toHaveTextContent('/pages/stateful')
  expect(usePageStore.getState().sessions).toHaveLength(1)
  expect(usePageStore.getState().sessions[0].id).toBe(id)
  expect(usePageStore.getState().sessions[0].presentation).toBe('expanded')
})

it('pins HTML through the context menu as an app and preserves its snapshot', async () => {
  const id = usePageStore
    .getState()
    .ensure({ id: 'pin-me', title: 'Pinned counter', source: { kind: 'html', html: '<input value="initial">' } })
  mount()
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Pinned counter' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin as app' }))
  await act(async () => {
    await getClock().tickAsync(100)
  })
  const saved = savedPagesFromRows(await getSavedPagesQuery(getDb(), 'pin-me'))[0]
  expect(saved.chrome).toBe('app')
  expect(saved.source).toEqual({ kind: 'html', html: '<input value="initial">' })
  act(() => usePageStore.getState().update(id, { chrome: 'app' }))
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Select element on page' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Show browser controls' })).toBeInTheDocument()
})

it('shows an external browser fallback on web and never renders a remote iframe', () => {
  usePageStore
    .getState()
    .ensure({ id: 'website', title: 'Website', source: { kind: 'url', url: 'https://example.com/' } })
  const { container } = mount()
  expect(screen.getByRole('link', { name: 'Open in your browser' })).toHaveAttribute('href', 'https://example.com/')
  expect(screen.getByRole('button', { name: 'Select element on page' })).toBeDisabled()
  expect(container.querySelector('iframe')).toBeNull()
})

it('saves a redirected website address but never turns a local app into a synced localhost bookmark', () => {
  const first = usePageStore
    .getState()
    .ensure({ id: 'redirect', title: '', source: { kind: 'url', url: 'https://example.com' } })
  const second = usePageStore
    .getState()
    .ensure({ id: 'local', title: 'My app', source: { kind: 'local-app', appId: 'local-id' } })
  for (const id of [first, second]) {
    usePageStore.getState().update(id, {
      browser: {
        url: 'http://127.0.0.1:12345/new',
        title: 'Updated title',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      },
    })
  }
  expect(pageDefinitionForPin(usePageStore.getState().sessions[0]).source).toEqual({
    kind: 'url',
    url: 'http://127.0.0.1:12345/new',
  })
  expect(pageDefinitionForPin(usePageStore.getState().sessions[1]).source).toEqual({
    kind: 'local-app',
    appId: 'local-id',
  })
  expect(pageReturnPath({ returnTo: 'https://example.com' })).toBe('/chats/new')
  expect(pageReturnPath({ returnTo: '//example.com' })).toBe('/chats/new')
  expect(pageReturnPath({ returnTo: '/chats/original?draft=1' })).toBe('/chats/original?draft=1')
})

it('never starts an imported HTML snapshot that fails verification or a cancelled restore', async () => {
  const malformed = createSavedPage(
    { id: 'malformed', title: 'Invalid', source: { kind: 'html', html: '<script>let = ;</script>' } },
    'app',
  )
  await expect(restoreSavedPage(malformed)).rejects.toThrow('could not be verified')
  expect(usePageStore.getState().sessions).toHaveLength(0)
  const abort = new AbortController()
  abort.abort()
  const url = createSavedPage(
    { id: 'cancelled', title: 'Website', source: { kind: 'url', url: 'https://example.com' } },
    'browser',
  )
  await expect(restoreSavedPage(url, abort.signal)).rejects.toThrow()
  expect(usePageStore.getState().sessions).toHaveLength(0)
})
