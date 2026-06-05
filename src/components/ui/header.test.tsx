/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { createAgent } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { builtInAgent } from '@/defaults/agents'
import { createTestProvider } from '@/test-utils/test-provider'
import {
  createMockChatThread,
  createMockMode,
  createMockModel,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'
import type { Agent } from '@/types/acp'
import type { ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { SignInModalProvider } from '@/contexts'
import { Header } from './header'

/** happy-dom exposes its control API on `window.happyDOM`, but the global
 *  registrator doesn't augment the DOM lib's `Window`. Declare the one method
 *  this test drives so `tsc --noEmit` stays green. */
declare global {
  // Global augmentation requires declaration merging, which only `interface` supports.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    happyDOM?: { setViewport: (viewport: { width: number }) => void }
  }
}

/** happy-dom's default viewport (matches the bun test preload). Restored after
 *  each test so the mobile override below never leaks. */
const desktopWidth = 1024

/** Forces `useIsMobile` (a `matchMedia` reader) to report mobile so `Header`
 *  renders its mobile layout, which centers the agent selector this suite
 *  asserts on. The wrapper still provides the desktop-only `PowerSyncStatus`
 *  tree (see `TestWrapper`) so the test passes in either layout — `useIsMobile`
 *  is global and a sibling suite may `mock.module` it to report desktop. */
const forceMobileViewport = () => window.happyDOM?.setViewport({ width: 375 })

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
 *  sign-in modal context that the desktop layout's `PowerSyncStatus` requires —
 *  so the suite is robust whether `Header` renders its mobile or desktop branch. */
const TestWrapper = ({ children }: { children: ReactNode }) => {
  const Provider = createTestProvider()
  return (
    <MemoryRouter initialEntries={['/chats/thread-1']}>
      <Provider>
        <SignInModalProvider>
          <SidebarProvider>{children}</SidebarProvider>
        </SignInModalProvider>
      </Provider>
    </MemoryRouter>
  )
}

/** Hydrates a session on the canonical `thread-1`, then patches its
 *  `selectedAgent` directly (mirrors `chat-model-picker.test.tsx`, avoiding the
 *  DB write that `setSelectedAgent` performs). */
const setupWithAgent = (agent: Agent) => {
  hydrateStore({
    // A real `Chat` (not the plain-object mock) so the AI SDK's `useChat`
    // subscription inside `HeaderAgentSelector` mounts cleanly. It stays in its
    // default `ready` status — the selector only reads `status` to disable
    // itself mid-stream.
    chatInstance: new Chat<ThunderboltUIMessage>({ id: 'thread-1' }),
    chatThread: createMockChatThread({ agentId: agent.id }),
    id: 'thread-1',
    modes: [createMockMode()],
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
    window.happyDOM?.setViewport({ width: desktopWidth })
    await resetTestDatabase()
  })

  it("pre-selects the thread's custom agent even when useAllAgents is still empty", () => {
    // No DB seed: `useAllAgents` returns only the built-in, exactly like the
    // first render after navigation before the synced agent rows hydrate.
    setupWithAgent(customAgent)

    render(<Header />, { wrapper: TestWrapper })

    expect(screen.getByText(customAgent.name)).toBeInTheDocument()
    expect(screen.queryByText(builtInAgent.name)).toBeNull()
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
})
