/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { builtInAgent } from '@/defaults/agents'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockMode,
  createMockModel,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { Agent } from '@/types/acp'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { ChatModePicker } from './chat-mode-picker'

const remoteAcpAgent: Agent = {
  id: 'remote-1',
  name: 'Remote Agent',
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

const managedAcpAgent: Agent = {
  ...remoteAcpAgent,
  id: 'managed-1',
  name: 'Managed Agent',
  type: 'managed-acp',
}

const TestWrapper = createQueryTestWrapper()

/** Hydrates the store with a session whose agent type is overridable.
 *
 * `hydrateStore` always assigns `builtInAgent`; we patch the session map after
 * the fact for tests that need a non-built-in agent. We mutate the store
 * directly (rather than via `setSelectedAgent`) to avoid the DB write the
 * persisting action performs. */
const setupWithAgent = (agent: Agent) => {
  const chatMode = createMockMode({ id: 'mode-chat', name: 'chat', label: 'Chat', icon: 'message-square' })
  const searchMode = createMockMode({
    id: 'mode-search',
    name: 'search',
    label: 'Search',
    icon: 'globe',
    isDefault: 0,
    order: 1,
  })

  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: createMockChatThread(),
    id: 'thread-1',
    modes: [chatMode, searchMode],
    models: [createMockModel()],
    selectedMode: chatMode,
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

describe('ChatModePicker', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    resetStore()
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    await resetTestDatabase()
  })

  it('renders the mode selector when the selected agent is built-in', () => {
    setupWithAgent(builtInAgent)

    render(<ChatModePicker />, { wrapper: TestWrapper })

    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('renders nothing when the selected agent is remote-acp', () => {
    setupWithAgent(remoteAcpAgent)

    const { container } = render(<ChatModePicker />, { wrapper: TestWrapper })

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('Chat')).toBeNull()
  })

  it('renders nothing when the selected agent is managed-acp', () => {
    setupWithAgent(managedAcpAgent)

    const { container } = render(<ChatModePicker />, { wrapper: TestWrapper })

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('Chat')).toBeNull()
  })

  it('renders nothing when the agent is built-in but no modes are configured', () => {
    hydrateStore({
      chatInstance: createMockChatInstance(),
      chatThread: createMockChatThread(),
      id: 'thread-1',
      modes: [],
      models: [createMockModel()],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    const { container } = render(<ChatModePicker />, { wrapper: TestWrapper })

    expect(container.firstChild).toBeNull()
  })

  it('changes the selected mode in the store on click', async () => {
    setupWithAgent(builtInAgent)

    render(<ChatModePicker />, { wrapper: TestWrapper })

    // Open the dropdown
    const trigger = screen.getByText('Chat')
    await act(async () => {
      fireEvent.click(trigger)
    })

    // Click the Search option
    const searchOption = await screen.findByText('Search')
    await act(async () => {
      fireEvent.click(searchOption)
    })

    const session = useChatStore.getState().sessions.get('thread-1')
    expect(session?.selectedMode.id).toBe('mode-search')
  })
})
