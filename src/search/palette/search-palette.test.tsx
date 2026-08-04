/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { scrollToMessageStateKey } from '@/chats/scroll-to-message-intent'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Bot, LogOut, Plus } from 'lucide-react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import type { PaletteCommand, UseCommandsOptions } from '../commands/types'
import type { SearchResult } from '../types'

const mockTrackEvent = mock((_event: string, _props?: Record<string, unknown>) => {})

// Partial mock: spread the REAL module so every other export survives if this
// registration leaks across files under `--randomize`. Only `trackEvent` is
// overridden with the spy this suite asserts on. See docs/development/testing.md §65.
const realPosthog = await import('@/lib/posthog')
mock.module('@/lib/posthog', () => ({
  ...realPosthog,
  trackEvent: mockTrackEvent,
}))

// The data-layer stream owns the real command list; this suite drives dispatch
// with a per-test builder so we control the exact commands (and reach the
// opts.onSignOut modal-opener) without depending on that stream's contents.
let buildCommands: (opts: UseCommandsOptions) => PaletteCommand[] = () => []
const realUseCommands = await import('../commands/use-commands')
mock.module('../commands/use-commands', () => ({
  ...realUseCommands,
  useCommands: (opts: UseCommandsOptions) => buildCommands(opts),
}))

// The FTS stream owns real search; this suite injects canned results so the
// action-row tests don't depend on a seeded index.
let searchResults: SearchResult[] = []
const realUseSearch = await import('../use-search')
mock.module('../use-search', () => ({
  ...realUseSearch,
  useSearch: () => ({ results: searchResults, isLoading: false }),
}))

const { SearchPalette } = await import('./search-palette')

const LocationProbe = () => {
  const location = useLocation()
  return (
    <div data-testid="location" data-state={JSON.stringify(location.state)}>
      {location.pathname}
    </div>
  )
}

const debounceMs = 180

const renderPalette = () => {
  const TestProvider = createTestProvider()
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/']}>
      <TestProvider>
        {children}
        <LocationProbe />
      </TestProvider>
    </MemoryRouter>
  )
  return render(<SearchPalette open onOpenChange={() => {}} />, { wrapper: Wrapper })
}

describe('SearchPalette commands', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mockTrackEvent.mockClear()
    buildCommands = () => []
    searchResults = []
  })

  afterEach(() => {
    cleanup()
  })

  it('renders commands grouped by section', () => {
    buildCommands = () => [
      { id: 'nav-agents', title: 'All agents', icon: Bot, section: 'navigation', to: '/settings/agents' },
    ]
    renderPalette()

    expect(screen.getByText('Go to')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /All agents/ })).toBeInTheDocument()
  })

  it('navigates and tracks the run event for a "to" command', () => {
    buildCommands = () => [
      { id: 'nav-agents', title: 'All agents', icon: Bot, section: 'navigation', to: '/settings/agents' },
    ]
    renderPalette()

    fireEvent.click(screen.getByRole('option', { name: /All agents/ }))

    expect(mockTrackEvent).toHaveBeenCalledWith('search_command_run', { commandId: 'nav-agents' })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/agents')
  })

  it('invokes run and tracks the run event for a "run" command', () => {
    const run = mock(() => {})
    buildCommands = () => [{ id: 'toggle-x', title: 'Toggle Something', icon: Bot, section: 'actions', run }]
    renderPalette()

    fireEvent.click(screen.getByRole('option', { name: /Toggle Something/ }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(mockTrackEvent).toHaveBeenCalledWith('search_command_run', { commandId: 'toggle-x' })
  })

  it('opens the logout modal when the sign-out command runs', () => {
    buildCommands = (opts) => [
      { id: 'sign-out', title: 'Sign out', icon: LogOut, section: 'actions', run: opts.onSignOut },
    ]
    renderPalette()

    expect(screen.queryByText('What would you like to do with your local data?')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /Sign out/ }))

    expect(screen.getByText('What would you like to do with your local data?')).toBeInTheDocument()
  })

  it('renders create commands under the "Create" heading', () => {
    buildCommands = () => [
      { id: 'create-model', title: 'Create model', icon: Plus, section: 'create', to: '/settings/models' },
    ]
    renderPalette()

    expect(screen.getByText('Create')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Create model/ })).toBeInTheDocument()
  })

  it('navigates with router state when a create command carries state', () => {
    const state = { modelsAction: JSON.stringify({ type: 'create' }) }
    buildCommands = () => [
      { id: 'create-model', title: 'Create model', icon: Plus, section: 'create', to: '/settings/models', state },
    ]
    renderPalette()

    fireEvent.click(screen.getByRole('option', { name: /Create model/ }))

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/models')
    expect(screen.getByTestId('location')).toHaveAttribute('data-state', JSON.stringify(state))
  })

  it('fires an entity action from a result row: navigates with intent state + tracks', async () => {
    searchResults = [{ id: 'gpt-4o', entityType: 'model', title: 'GPT-4o', snippet: '', to: '/settings/models' }]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'gpt' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))

    expect(mockTrackEvent).toHaveBeenCalledWith('search_action_run', { entityType: 'model', action: 'edit' })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/models')
    expect(screen.getByTestId('location')).toHaveAttribute(
      'data-state',
      JSON.stringify({ modelsAction: JSON.stringify({ type: 'edit', id: 'gpt-4o' }) }),
    )
  })

  it('navigates to a message result with scroll-to-message intent state and flags the analytics event', async () => {
    searchResults = [
      { id: 'msg-42', entityType: 'message', title: 'A matching message', snippet: '', to: '/chats/thread-9' },
    ]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'matching' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    fireEvent.click(screen.getByRole('option', { name: /A matching message/ }))

    expect(mockTrackEvent).toHaveBeenCalledWith('search_result_select', { entityType: 'message', jumpToMessage: true })
    expect(screen.getByTestId('location')).toHaveTextContent('/chats/thread-9')
    expect(screen.getByTestId('location')).toHaveAttribute(
      'data-state',
      JSON.stringify({ [scrollToMessageStateKey]: 'msg-42' }),
    )
  })

  it('navigates to a non-message result with no state and an unset jump flag', async () => {
    searchResults = [
      { id: 'thread-9', entityType: 'chat', title: 'A matching chat', snippet: '', to: '/chats/thread-9' },
    ]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'matching' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    fireEvent.click(screen.getByRole('option', { name: /A matching chat/ }))

    expect(mockTrackEvent).toHaveBeenCalledWith('search_result_select', { entityType: 'chat', jumpToMessage: false })
    expect(screen.getByTestId('location')).toHaveTextContent('/chats/thread-9')
    expect(screen.getByTestId('location')).toHaveAttribute('data-state', 'null')
  })

  it('keeps FTS result rows that cmdk fuzzy filtering would hide', async () => {
    // "GPT model" is a valid FTS hit for "models" (stemmed/plural), but the raw
    // query is not a subsequence of the row text — cmdk's built-in filter would
    // drop it. shouldFilter={false} must keep it visible.
    searchResults = [{ id: 'gpt', entityType: 'model', title: 'GPT model', snippet: '', to: '/settings/models' }]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'models' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    expect(screen.getByRole('option', { name: /GPT model/ })).toBeInTheDocument()
    expect(screen.queryByText('No results found.')).not.toBeInTheDocument()
  })

  it('filters the static command list by the query itself (cmdk filter is off)', async () => {
    buildCommands = () => [
      { id: 'nav-models', title: 'Models', icon: Bot, section: 'navigation', to: '/settings/models' },
      { id: 'nav-agents', title: 'All agents', icon: Bot, section: 'navigation', to: '/settings/agents' },
    ]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'models' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    expect(screen.getByRole('option', { name: /Models/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /All agents/ })).not.toBeInTheDocument()
  })
})
