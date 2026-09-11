/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { createAgent } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { builtInAgent } from '@/defaults/agents'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { createMockChatThread, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'
import type { Agent } from '@/types/acp'
import type { ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { CreateItemProvider } from '@/components/create-item/context'
import { CreateRequestProbe } from '@/test-utils/create-request-probe'
import { SignInModalProvider } from '@/contexts'
import { Header } from './header'

/** A custom (synced) agent the thread is pinned to. */
const customAgent: Agent = {
  id: 'custom-1',
  name: 'My Custom Agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.com',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
}

/** Wraps the component in everything `Header` touches: a router (it reads
 *  `location.pathname`), the sidebar context (`useSidebar`), the DAL/query
 *  providers so `useAllAgents` can run against the test database, and the
 *  sign-in modal context — so the suite is robust whether `Header` renders its
 *  mobile or desktop branch. */
const TestWrapper = ({ children }: { children: ReactNode }) => {
  const Provider = createTestProvider()
  return (
    <MemoryRouter initialEntries={['/chats/thread-1']}>
      <Provider>
        <SignInModalProvider>
          <SidebarProvider>
            <CreateItemProvider>
              {children}
              <CreateRequestProbe />
            </CreateItemProvider>
          </SidebarProvider>
        </SignInModalProvider>
      </Provider>
    </MemoryRouter>
  )
}

/** Hydrates a session on the canonical `thread-1`, then patches its
 *  `selectedAgent` directly (mirrors `chat-model-picker.test.tsx`, avoiding the
 *  DB write that `setSelectedAgent` performs). Pass `withThread: false` to
 *  simulate an unsaved new chat (no thread row yet). */
const setupWithAgent = (agent: Agent, { withThread = true }: { withThread?: boolean } = {}) => {
  hydrateStore({
    // A real `Chat` (not the plain-object mock) so the AI SDK's `useChat`
    // subscription inside `HeaderAgentSelector` mounts cleanly. It stays in its
    // default `ready` status — the selector only reads `status` to disable
    // itself mid-stream.
    chatInstance: new Chat<ThunderboltUIMessage>({ id: 'thread-1' }),
    chatThread: withThread ? createMockChatThread({ agentId: agent.id }) : null,
    id: 'thread-1',
    models: [createMockModel()],
    selectedModel: createMockModel(),
    triggerData: null,
  })

  useChatStore.setState((state) => {
    const session = state.sessions.get('thread-1')
    if (!session) {
      return state
    }
    const nextSessions = new Map(state.sessions)
    nextSessions.set('thread-1', { ...session, selectedAgent: agent })
    return { sessions: nextSessions }
  })
}

/** Flushes the `useAllAgents` TanStack/PowerSync query so the seeded rows land
 *  in the reactive list. The clock is global+fake; advance it inside `act`. */
const flushAgentsQuery = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('Header', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    forceMobileViewport()
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    restoreViewport()
    await resetTestDatabase()
  })

  it("pre-selects the thread's custom agent even when useAllAgents is still empty", () => {
    // No DB seed: `useAllAgents` returns only the built-in, exactly like the
    // first render after navigation before the synced agent rows hydrate.
    setupWithAgent(customAgent)

    render(<Header />, { wrapper: TestWrapper })

    expect(screen.getByText(customAgent.name)).toBeInTheDocument()
    expect(screen.queryByText(builtInAgent.name)).toBeNull()
    expect(screen.getByTestId('agent-selector-trigger').closest('button')?.parentElement).toHaveClass('top-2')
  })

  it('keeps showing the thread agent after the synced list hydrates', async () => {
    // Once `useAllAgents` resolves and the thread's custom agent appears in the
    // list, the header must still display it (the selector now finds it by id).
    // This guards against the fix accidentally pinning to the empty-list state.
    await createAgent(getDb(), {
      id: customAgent.id,
      name: customAgent.name,
      type: 'remote-acp',
      transport: 'websocket',
      url: 'wss://example.com',
      userId: 'user-1',
    })
    setupWithAgent(customAgent)

    render(<Header />, { wrapper: TestWrapper })
    await flushAgentsQuery()

    expect(screen.getByText(customAgent.name)).toBeInTheDocument()
    expect(screen.queryByText(builtInAgent.name)).toBeNull()
  })

  it('falls back to the built-in agent when the session has no agent', () => {
    setupWithAgent(builtInAgent)

    render(<Header />, { wrapper: TestWrapper })

    expect(screen.getByText(builtInAgent.name)).toBeInTheDocument()
  })

  it('centers an expanded pill on an unsaved new chat (mobile)', () => {
    setupWithAgent(customAgent, { withThread: false })

    render(<Header />, { wrapper: TestWrapper })

    const wrapper = screen.getByTestId('agent-selector-trigger').closest('button')?.parentElement
    expect(wrapper).toHaveClass('left-1/2', '[translate:-50%_0]')
    expect(screen.getByTestId('agent-selector-collapsed-circle')).toHaveClass('opacity-0')
  })

  it('docks a collapsed circle top-right once the chat has a thread (mobile)', () => {
    setupWithAgent(customAgent)

    render(<Header />, { wrapper: TestWrapper })

    const wrapper = screen.getByTestId('agent-selector-trigger').closest('button')?.parentElement
    // `left` stays fixed — only `translate` differs between the two states,
    // so the dock slide can run entirely on the compositor.
    expect(wrapper).toHaveClass('left-1/2', '[translate:calc(50cqw-100%)_0]')
    expect(wrapper).not.toHaveClass('[translate:-50%_0]')
    expect(screen.getByTestId('agent-selector-collapsed-circle')).toHaveClass('opacity-100', 'max-md:bg-muted/80')
  })

  it('opens agent creation over the current chat route', async () => {
    setupWithAgent(builtInAgent)
    render(<Header />, { wrapper: TestWrapper })

    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    fireEvent.click(await screen.findByText('Add Agent'))

    expect(screen.getByTestId('create-request')).toHaveTextContent('/chats/thread-1|agent')
  })
})
