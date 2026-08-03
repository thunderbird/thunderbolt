/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Bot, LogOut } from 'lucide-react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import type { PaletteCommand, UseCommandsOptions } from '../commands/types'

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

const { SearchPalette } = await import('./search-palette')

const LocationProbe = () => <div data-testid="location">{useLocation().pathname}</div>

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
})
