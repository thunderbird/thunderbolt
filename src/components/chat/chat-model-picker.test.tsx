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
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { ChatModelPicker } from './chat-model-picker'

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

const gpt4 = createMockModel({ id: 'model-1', name: 'GPT-4', provider: 'thunderbolt', isSystem: 1 })
const gpt5 = createMockModel({ id: 'model-2', name: 'GPT-5', provider: 'thunderbolt', isSystem: 1 })

const QueryWrapper = createQueryTestWrapper()

/** Wraps the query/provider tree in a router since ChatModelPicker navigates. */
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <QueryWrapper>{children}</QueryWrapper>
  </MemoryRouter>
)

/** Hydrates the store with a built-in session, then patches the agent. Mirrors
 *  the ChatModePicker test: `hydrateStore` always assigns `builtInAgent`, so we
 *  mutate the session map directly to avoid the DB write `setSelectedAgent` does. */
const setupWithAgent = (agent: Agent, models = [gpt4, gpt5]) => {
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: createMockChatThread(),
    id: 'thread-1',
    modes: [createMockMode({ id: 'mode-chat', name: 'chat', label: 'Chat', icon: 'message-square' })],
    models,
    selectedModel: models[0],
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

describe('ChatModelPicker', () => {
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

  it('renders the model selector when the selected agent is built-in', () => {
    setupWithAgent(builtInAgent)

    render(<ChatModelPicker />, { wrapper: TestWrapper })

    expect(screen.getByText('GPT-4')).toBeInTheDocument()
  })

  it('renders nothing when the selected agent is remote-acp', () => {
    setupWithAgent(remoteAcpAgent)

    const { container } = render(<ChatModelPicker />, { wrapper: TestWrapper })

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('GPT-4')).toBeNull()
  })

  it('renders nothing when the selected agent is managed-acp', () => {
    setupWithAgent(managedAcpAgent)

    const { container } = render(<ChatModelPicker />, { wrapper: TestWrapper })

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the agent is built-in but no models are configured', () => {
    setupWithAgent(builtInAgent, [])

    const { container } = render(<ChatModelPicker />, { wrapper: TestWrapper })

    expect(container.firstChild).toBeNull()
  })

  it('changes the selected model in the store on click', async () => {
    setupWithAgent(builtInAgent)

    render(<ChatModelPicker />, { wrapper: TestWrapper })

    await act(async () => {
      fireEvent.click(screen.getByText('GPT-4'))
    })

    const option = await screen.findByText('GPT-5')
    await act(async () => {
      fireEvent.click(option)
    })

    const session = useChatStore.getState().sessions.get('thread-1')
    expect(session?.selectedModel.id).toBe('model-2')
  })
})
