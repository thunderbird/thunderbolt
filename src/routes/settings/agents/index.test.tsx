/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { createAgent, getAllAgents } from '@/dal'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import AgentsSettingsPage from './index'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const settingsIndexMarker = 'settings-index-marker'

const renderPage = (authClient: AuthClient, isStandalone: () => boolean) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <MemoryRouter initialEntries={['/settings/agents']}>
        <Routes>
          <Route path="/settings/agents" element={children} />
          <Route path="/settings" element={<div data-testid={settingsIndexMarker} />} />
        </Routes>
      </MemoryRouter>
    </TestProvider>
  )
  return render(<AgentsSettingsPage isStandalone={isStandalone} />, { wrapper: Wrapper })
}

const onTauri = () => true
const offTauri = () => false

describe('AgentsSettingsPage — hidden state guard', () => {
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

  it('redirects to /settings for anonymous users when the proxy is effectively on (web)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient, offTauri)

    expect(screen.getByTestId(settingsIndexMarker)).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('redirects for anonymous users on Tauri Connected (proxy_enabled=true)', () => {
    localStorage.setItem('proxy_enabled', 'true')
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient, onTauri)

    expect(screen.getByTestId(settingsIndexMarker)).toBeInTheDocument()
  })

  it('renders the page for anonymous users on Tauri Standalone (proxy off)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient, onTauri)

    expect(screen.queryByTestId(settingsIndexMarker)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add custom agent/i })).toBeInTheDocument()
  })

  it('renders the page for authenticated users behind the proxy (web)', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, offTauri)

    expect(screen.queryByTestId(settingsIndexMarker)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add custom agent/i })).toBeInTheDocument()
  })

  it('renders the page for authenticated users on Tauri Standalone', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, onTauri)

    expect(screen.queryByTestId(settingsIndexMarker)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add custom agent/i })).toBeInTheDocument()
  })
})

describe('AgentsSettingsPage — transparent same-account enrollment', () => {
  const irohTarget = 'a'.repeat(52)
  const appNodeId = 'b'.repeat(52)

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

  const renderIrohAgentsPage = (enrollIroh: () => Promise<void>) => {
    const authClient = createMockAuthClient({ session: authedSession })
    const TestProvider = createTestProvider({ authClient })
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <MemoryRouter initialEntries={['/settings/agents']}>
          <Routes>
            <Route path="/settings/agents" element={children} />
            <Route path="/settings" element={<div data-testid={settingsIndexMarker} />} />
          </Routes>
        </MemoryRouter>
      </TestProvider>
    )
    render(
      <AgentsSettingsPage isStandalone={offTauri} loadAppNodeId={async () => appNodeId} enrollIroh={enrollIroh} />,
      { wrapper: Wrapper },
    )
  }

  // Renders the authed page, opens the Add dialog, and types a name + iroh ticket so the
  // submit lands on the iroh transport. `loadAppNodeId` keeps the pairing panel off the
  // wasm client; `enrollIroh` is the injected app self-enrollment seam.
  const openAddIrohAgent = async (enrollIroh: () => Promise<void>) => {
    renderIrohAgentsPage(enrollIroh)
    fireEvent.click(screen.getByRole('button', { name: /add custom agent/i }))
    fireEvent.change(screen.getByPlaceholderText('My Agent'), { target: { value: 'Laptop Bridge' } })
    fireEvent.change(screen.getByPlaceholderText(/paste an iroh ticket/i), { target: { value: irohTarget } })
  }

  it('self-enrolls this app when adding an iroh agent', async () => {
    const enrollIroh = mock(async () => {})
    await openAddIrohAgent(enrollIroh)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    expect(enrollIroh).toHaveBeenCalledTimes(1)
    expect(enrollIroh).toHaveBeenCalledWith()
    const created = await getAllAgents(getDb())
    expect(created.some((agent) => agent.url === irohTarget)).toBe(true)
  })

  it('still creates the agent and keeps the manual pairing panel when enrollment fails', async () => {
    const enrollIroh = mock(async () => {
      throw new Error('no account (standalone)')
    })
    await openAddIrohAgent(enrollIroh)
    // The manual `thunderbolt iroh allow` one-liner is present as the fallback path.
    expect(screen.getByTestId('iroh-pairing-panel')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    // The failed enrollment did not block the add — the agent row was still created.
    const created = await getAllAgents(getDb())
    expect(created.some((agent) => agent.url === irohTarget)).toBe(true)
  })

  it('does not block the add on a slow (never-resolving) enrollment', async () => {
    // Enrollment that never settles — a fire-and-forget add must still complete and close.
    const enrollIroh = mock(() => new Promise<void>(() => {}))
    await openAddIrohAgent(enrollIroh)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    // Row created and the dialog closed despite the hung enrollment.
    const created = await getAllAgents(getDb())
    expect(created.some((agent) => agent.url === irohTarget)).toBe(true)
    expect(screen.queryByPlaceholderText(/paste an iroh ticket/i)).not.toBeInTheDocument()
  })

  it('does not enroll when editing an iroh agent', async () => {
    const db = getDb()
    const agentId = 'existing-iroh-agent'
    const enrollIroh = mock(async () => {})
    await createAgent(db, {
      id: agentId,
      name: 'Existing Bridge',
      type: 'remote-acp',
      transport: 'iroh',
      url: irohTarget,
      description: null,
      enabled: 1,
      userId: authedSession.user.id,
    })
    renderIrohAgentsPage(enrollIroh)

    await act(async () => {
      await getClock().runAllAsync()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Existing Bridge' }))
    fireEvent.change(screen.getByPlaceholderText('My Agent'), { target: { value: 'Renamed Bridge' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
      await getClock().runAllAsync()
    })

    expect(enrollIroh).not.toHaveBeenCalled()
    const updated = (await getAllAgents(db)).find((agent) => agent.id === agentId)
    expect(updated?.name).toBe('Renamed Bridge')
  })
})
