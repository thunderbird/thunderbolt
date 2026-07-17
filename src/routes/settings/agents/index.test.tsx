/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import AgentsSettingsPage from './index'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const renderPage = (authClient: AuthClient) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <MemoryRouter initialEntries={['/settings/agents']}>{children}</MemoryRouter>
    </TestProvider>
  )
  return render(<AgentsSettingsPage />, { wrapper: Wrapper })
}

// The page is available to everyone: the built-in agent is local-first and
// custom ACP agents (including iroh targets, which bypass the proxy entirely)
// work without a real account, so there is no auth-based gating.
describe('AgentsSettingsPage — availability', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('renders for anonymous users', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add custom agent/i })).toBeInTheDocument()
  })

  it('renders for authenticated users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add custom agent/i })).toBeInTheDocument()
  })

  it('opens the detail panel when a row is clicked and closes it again', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    // Nothing selected — the built-in detail heading only exists in the panel.
    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Thunderbolt' }))

    expect(screen.getByRole('heading', { name: 'Thunderbolt' })).toBeInTheDocument()
    expect(screen.getByText(/built into the app — always here/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
  })
})
