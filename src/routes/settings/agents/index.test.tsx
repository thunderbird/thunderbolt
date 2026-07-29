/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import type { AuthClient } from '@/contexts'
import { createAgent, getAllAgents } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import AgentsSettingsPage from './index'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

type PageProps = Parameters<typeof AgentsSettingsPage>[0]

const renderPage = (authClient: AuthClient, props: PageProps = {}, mockResponse?: unknown) => {
  const TestProvider = createTestProvider({ authClient, mockResponse })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <MemoryRouter initialEntries={['/settings/agents']}>{children}</MemoryRouter>
    </TestProvider>
  )
  return render(<AgentsSettingsPage {...props} />, { wrapper: Wrapper })
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
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument()
  })

  it('renders for authenticated users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument()
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

describe('AgentsSettingsPage — add-agent panel', () => {
  const catalogWith = (descriptors: unknown[]) => ({ version: '1', descriptors })

  const haystackDescriptor = {
    id: 'haystack',
    provider: 'haystack',
    name: 'Haystack RAG agent',
    description: null,
    icon: null,
    schemaVersion: 1,
    action: 'deploy',
    steps: [{ id: 'basics', title: 'Basics', fields: [{ key: 'name', label: 'Name', widget: 'text' }] }],
  }

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
    useConfigStore.getState().updateConfig({} as AppConfig)
  })

  const setConfig = (config: AppConfig) => {
    act(() => useConfigStore.getState().updateConfig(config))
  }

  it('lists Connect first alongside the catalog when deploy is enabled', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }), {}, catalogWith([haystackDescriptor]))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))

    const connect = await waitForElement(() => screen.queryByText('Connect custom agent'))
    const deployCard = screen.getByText('Haystack RAG agent')
    expect(connect).toBeInTheDocument()
    // Connect is the first card in the list.
    expect(connect.compareDocumentPosition(deployCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('routes a catalog entry to its descriptor form', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }), {}, catalogWith([haystackDescriptor]))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    fireEvent.click(await waitForElement(() => screen.queryByText('Haystack RAG agent')))

    expect(screen.getByRole('button', { name: /deploy/i })).toBeInTheDocument()
  })

  it('routes Connect to the inline custom form', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }), {}, catalogWith([haystackDescriptor]))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    fireEvent.click(await waitForElement(() => screen.queryByText('Connect custom agent')))

    expect(screen.getByPlaceholderText('My Agent')).toBeInTheDocument()
  })

  it('goes back to the list from a descriptor form', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }), {}, catalogWith([haystackDescriptor]))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    fireEvent.click(await waitForElement(() => screen.queryByText('Haystack RAG agent')))
    expect(screen.getByRole('button', { name: /deploy/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))

    expect(screen.getByText('Connect custom agent')).toBeInTheDocument()
    expect(screen.getByText('Haystack RAG agent')).toBeInTheDocument()
  })

  it('goes back to the list from the connect form', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }), {}, catalogWith([haystackDescriptor]))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    fireEvent.click(await waitForElement(() => screen.queryByText('Connect custom agent')))
    expect(screen.getByPlaceholderText('My Agent')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))

    expect(screen.getByText('Haystack RAG agent')).toBeInTheDocument()
  })

  it('shows the connect form directly when the catalog is empty', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }), {}, catalogWith([]))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))

    expect(await waitForElement(() => screen.queryByPlaceholderText('My Agent'))).toBeInTheDocument()
    expect(screen.queryByText('Connect custom agent')).not.toBeInTheDocument()
    // No list to return to → no back affordance.
    expect(screen.queryByRole('button', { name: 'Go back' })).not.toBeInTheDocument()
  })

  it('opens the connect form directly when deploy is disabled', () => {
    setConfig({ allowCustomAgents: true })
    renderPage(createMockAuthClient({ session: authedSession }))

    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))

    expect(screen.getByPlaceholderText('My Agent')).toBeInTheDocument()
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

  /** Opens the New Agent form and enters a valid iroh target. */
  const openAddIrohAgent = (enrollIroh: () => Promise<void>) => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, { loadAppNodeId: async () => appNodeId, enrollIroh })
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    fireEvent.change(screen.getByPlaceholderText('My Agent'), { target: { value: 'Laptop Bridge' } })
    fireEvent.change(screen.getByPlaceholderText(/paste an iroh ticket/i), { target: { value: irohTarget } })
  }

  it('self-enrolls this app exactly once when adding an iroh agent', async () => {
    const enrollIroh = mock(async () => {})
    openAddIrohAgent(enrollIroh)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    expect(enrollIroh).toHaveBeenCalledTimes(1)
    expect(enrollIroh).toHaveBeenCalledWith()
    expect((await getAllAgents(getDb())).some((agent) => agent.url === irohTarget)).toBe(true)
  })

  it('still creates the agent when enrollment fails', async () => {
    const enrollIroh = mock(async () => {
      throw new Error('no account (standalone)')
    })
    openAddIrohAgent(enrollIroh)
    expect(screen.getByTestId('iroh-pairing-panel')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    expect((await getAllAgents(getDb())).some((agent) => agent.url === irohTarget)).toBe(true)
  })

  it('does not block the add on a never-resolving enrollment', async () => {
    const enrollIroh = mock(() => new Promise<void>(() => {}))
    openAddIrohAgent(enrollIroh)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    expect((await getAllAgents(getDb())).some((agent) => agent.url === irohTarget)).toBe(true)
    expect(screen.queryByPlaceholderText(/paste an iroh ticket/i)).not.toBeInTheDocument()
  })

  it('does not enroll when editing an iroh agent', async () => {
    const db = getDb()
    const enrollIroh = mock(async () => {})
    await createAgent(db, {
      id: 'existing-iroh-agent',
      name: 'Existing Bridge',
      type: 'remote-acp',
      transport: 'iroh',
      url: irohTarget,
      description: null,
      enabled: 1,
      userId: authedSession.user.id,
    })
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, { loadAppNodeId: async () => appNodeId, enrollIroh })

    const openButton = await waitForElement(() => screen.queryByRole('button', { name: 'Open Existing Bridge' }))
    fireEvent.click(openButton)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed Bridge' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await getClock().runAllAsync()
    })

    expect(enrollIroh).not.toHaveBeenCalled()
    expect((await getAllAgents(db)).find((agent) => agent.id === 'existing-iroh-agent')?.name).toBe('Renamed Bridge')
  })
})
