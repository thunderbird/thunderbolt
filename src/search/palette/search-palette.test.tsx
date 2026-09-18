/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { scrollToMessageStateKey } from '@/chats/scroll-to-message-intent'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import { SidebarProvider } from '@/components/ui/sidebar'
import { createModel } from '@/dal'
import { getDb } from '@/db/database'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Bot, LogOut, Plus } from 'lucide-react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type ReactNode, useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import type { PaletteCommand, UseCommandsOptions } from '../commands/types'
import type { SearchResult } from '../types'
import { SearchPalette } from './search-palette'

// The palette's data/analytics dependencies are injected as props (no shared
// module mocking — that leaks worker-wide under `--randomize`). Each test drives
// dispatch with a canned command builder / result set and asserts on the spy.
const mockTrackEvent = mock((_event: string, _props?: Record<string, unknown>) => {})
let buildCommands: (opts: UseCommandsOptions) => PaletteCommand[] = () => []
let searchResults: SearchResult[] = []

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
        <SidebarProvider>
          {children}
          <LocationProbe />
        </SidebarProvider>
      </TestProvider>
    </MemoryRouter>
  )
  return render(
    <SearchPalette
      open
      onOpenChange={() => {}}
      useCommands={(opts) => buildCommands(opts)}
      useSearch={() => ({ results: searchResults, isLoading: false })}
      trackEvent={mockTrackEvent}
    />,
    { wrapper: Wrapper },
  )
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
    restoreViewport()
  })

  it('renders commands grouped by section', () => {
    buildCommands = () => [
      { id: 'nav-agents', title: 'All agents', icon: Bot, section: 'navigation', to: '/settings/agents' },
    ]
    renderPalette()

    expect(screen.getByText('Go to')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /All agents/ })).toBeInTheDocument()
  })

  it('navigates and tracks the run event for a "to" command', async () => {
    buildCommands = () => [
      { id: 'nav-agents', title: 'All agents', icon: Bot, section: 'navigation', to: '/settings/agents' },
    ]
    renderPalette()

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /All agents/ }))
    })

    expect(mockTrackEvent).toHaveBeenCalledWith('search_command_run', { commandId: 'nav-agents' })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/agents')
  })

  it('closes after a navigation command runs', async () => {
    buildCommands = () => [
      { id: 'nav-preferences', title: 'Preferences', icon: Bot, section: 'navigation', to: '/settings/preferences' },
    ]
    const TestProvider = createTestProvider()
    const ControlledPalette = () => {
      const [open, setOpen] = useState(true)
      return (
        <SearchPalette
          open={open}
          onOpenChange={setOpen}
          useCommands={(opts) => buildCommands(opts)}
          useSearch={() => ({ results: searchResults, isLoading: false })}
          trackEvent={mockTrackEvent}
        />
      )
    }
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/']}>
        <TestProvider>
          <SidebarProvider>
            {children}
            <LocationProbe />
          </SidebarProvider>
        </TestProvider>
      </MemoryRouter>
    )
    render(<ControlledPalette />, { wrapper: Wrapper })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Preferences/ }))
    })

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/preferences')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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

  it('navigates with router state when a create command carries state', async () => {
    const state = { modelsAction: JSON.stringify({ type: 'create' }) }
    buildCommands = () => [
      { id: 'create-model', title: 'Create model', icon: Plus, section: 'create', to: '/settings/models', state },
    ]
    renderPalette()

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create model/ }))
    })

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/models')
    expect(screen.getByTestId('location')).toHaveAttribute('data-state', JSON.stringify(state))
  })

  it('routes a click on an edit-supporting result straight to its edit panel', async () => {
    searchResults = [{ id: 'gpt-4o', entityType: 'model', title: 'GPT-4o', snippet: '', to: '/settings/models' }]
    renderPalette()

    // Query the whole title so the highlight wraps it in a single <mark> — a
    // substring match ("gpt") would split the accessible name into "GPT -4o".
    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'gpt-4o' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /GPT-4o/ }))
    })

    expect(mockTrackEvent).toHaveBeenCalledWith('search_result_select', { entityType: 'model', jumpToMessage: false })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/models')
    expect(screen.getByTestId('location')).toHaveAttribute(
      'data-state',
      JSON.stringify({ modelsAction: JSON.stringify({ type: 'edit', id: 'gpt-4o' }) }),
    )
  })

  it('sends a system-only model to the models page instead of opening the edit form', async () => {
    await createModel(getDb(), { id: 'sys-1', provider: 'openai', name: 'System Model', model: 'sys', isSystem: 1 })
    searchResults = [{ id: 'sys-1', entityType: 'model', title: 'System Model', snippet: '', to: '/settings/models' }]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'system' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /System/ }))
    })

    expect(mockTrackEvent).toHaveBeenCalledWith('search_result_select', { entityType: 'model', jumpToMessage: false })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/models')
    // No edit-intent state — a system-only model can't be edited.
    expect(screen.getByTestId('location')).toHaveAttribute('data-state', 'null')
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

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /A matching message/ }))
    })

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

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /A matching chat/ }))
    })

    expect(mockTrackEvent).toHaveBeenCalledWith('search_result_select', { entityType: 'chat', jumpToMessage: false })
    expect(screen.getByTestId('location')).toHaveTextContent('/chats/thread-9')
    expect(screen.getByTestId('location')).toHaveAttribute('data-state', 'null')
  })

  it('matches a localized command title typed without its diacritics', async () => {
    // Commands never enter FTS — their titles are resolved in the active locale
    // at render time — but they fold like the index does, so an ASCII keyboard
    // still reaches them.
    buildCommands = () => [
      { id: 'nav-prefs', title: 'Paramètres', icon: Bot, section: 'navigation', to: '/settings/preferences' },
      { id: 'nav-devices', title: 'Geräte', icon: Bot, section: 'navigation', to: '/settings/devices' },
    ]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'parametres' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    expect(screen.getByRole('option', { name: /Paramètres/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Geräte/ })).not.toBeInTheDocument()
  })

  it('matches a command title in an unsegmented script', async () => {
    buildCommands = () => [
      { id: 'nav-prefs', title: '設定', icon: Bot, section: 'navigation', to: '/settings/preferences' },
    ]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: '設定' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    expect(screen.getByRole('option', { name: /設定/ })).toBeInTheDocument()
  })

  it('keeps FTS result rows that cmdk fuzzy filtering would hide', async () => {
    // "GPT model" is a valid FTS hit for "model" (prefix match), but the raw
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

  it('renders as a top-sheet drawer (not a centered dialog) on mobile and still selects results', async () => {
    forceMobileViewport()
    searchResults = [{ id: 'gpt-4o', entityType: 'model', title: 'GPT-4o', snippet: '', to: '/settings/models' }]
    renderPalette()

    // Mobile presentation is the shared MobileCardMenu drawer, matching the agent picker.
    expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'gpt-4o' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /GPT-4o/ }))
    })

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/models')
  })

  it('hides the tasks result group when the tasks feature flag is off (still indexed, just not shown)', async () => {
    // The test settings default `experimental_feature_tasks` to off.
    searchResults = [{ id: 'task-1', entityType: 'task', title: 'Buy milk', snippet: '', to: '/tasks' }]
    renderPalette()

    fireEvent.change(screen.getByPlaceholderText(/Search chats/), { target: { value: 'milk' } })
    await act(async () => {
      await getClock().tickAsync(debounceMs)
    })

    expect(screen.queryByRole('option', { name: /Buy milk/ })).not.toBeInTheDocument()
    expect(screen.getByText('No results found.')).toBeInTheDocument()
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
