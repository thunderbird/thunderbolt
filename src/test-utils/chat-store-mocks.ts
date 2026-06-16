/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearAdapterCache } from '@/acp/adapter-cache'
import { useChatStore } from '@/chats/chat-store'
import { builtInAgent } from '@/defaults/agents'
import type { AutomationRun, ChatThread, Mode, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { mock } from 'bun:test'

/**
 * Creates a mock Mode for testing
 */
export const createMockMode = (overrides?: Partial<Mode>): Mode =>
  ({
    id: 'mode-chat',
    name: 'chat',
    label: 'Chat',
    icon: 'message-square',
    systemPrompt: null,
    isDefault: 1,
    order: 0,
    ...overrides,
  }) as Mode

/**
 * Creates a mock Model for testing
 */
export const createMockModel = (overrides?: Partial<Model>): Model =>
  ({
    id: 'model-1',
    provider: 'openai',
    name: 'Test Model',
    model: 'gpt-4',
    isSystem: 0,
    enabled: 1,
    isConfidential: 0,
    ...overrides,
  }) as Model

/**
 * Creates a mock ChatThread for testing
 */
export const createMockChatThread = (overrides?: Partial<ChatThread>): ChatThread =>
  ({
    id: 'thread-1',
    title: 'Test Thread',
    isEncrypted: 0,
    workspaceId: '00000000-0000-0000-0000-000000000001',
    ...overrides,
  }) as ChatThread

/**
 * Creates a mock AutomationRun for testing
 */
export const createMockAutomationRun = (overrides?: Partial<AutomationRun>): AutomationRun => ({
  prompt: null,
  wasTriggeredByAutomation: false,
  isAutomationDeleted: false,
  ...overrides,
})

/**
 * Creates a simple mock Chat instance for testing
 */
export const createMockChatInstance = (
  messages: ThunderboltUIMessage[] = [],
  status: 'ready' | 'streaming' | 'submitted' | 'error' = 'ready',
): Chat<ThunderboltUIMessage> => {
  const sendMessage = mock(async (_params: { text: string; metadata?: Record<string, unknown> }) => {
    // Mock implementation
  })
  const regenerate = mock(() => Promise.resolve())

  return {
    id: 'test-chat-id',
    messages,
    sendMessage,
    status,
    regenerate,
    stop: mock(),
    append: mock(),
    reload: mock(),
    setMessages: mock(),
    setData: mock(),
    setStatus: mock(),
  } as unknown as Chat<ThunderboltUIMessage>
}

/**
 * Creates a mock useChat hook that reads from a chat instance
 */
export const createMockUseChat = (chatInstance: Chat<ThunderboltUIMessage>, error?: Error) =>
  ((_options?: { chat?: Chat<ThunderboltUIMessage> }) => ({
    id: chatInstance.id,
    status: chatInstance.status,
    messages: chatInstance.messages,
    error,
    isLoading: false,
    reload: mock(),
    stop: chatInstance.stop,
    append: mock(),
    setMessages: mock(),
    setData: mock(),
    sendMessage: chatInstance.sendMessage,
    regenerate: chatInstance.regenerate,
    resumeStream: mock(),
    addToolResult: mock(),
    clearError: mock(),
  })) as unknown as typeof import('@ai-sdk/react').useChat

/**
 * Creates a mock Chat instance with validation logic that matches real implementation.
 * Use this when testing sendMessage validation behavior.
 */
export const createMockChatInstanceWithValidation = (
  messages: ThunderboltUIMessage[] = [],
): Chat<ThunderboltUIMessage> & { _originalSendMessage: ReturnType<typeof mock> } => {
  const originalSendMessage = mock(async (_params: { text: string; metadata?: Record<string, unknown> }) => {
    // Mock implementation
  })

  // Wrap sendMessage with validation logic to match real implementation
  const sendMessage = async (params: { text: string; metadata?: Record<string, unknown> }) => {
    const { currentSessionId, sessions } = useChatStore.getState()
    const session = currentSessionId ? sessions.get(currentSessionId) : null

    if (!session?.selectedModel) {
      throw new Error('No selected model')
    }

    const chatThread = session.chatThread

    if (chatThread && chatThread.isEncrypted !== session.selectedModel.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

    return originalSendMessage(params)
  }

  return {
    id: 'test-chat-id',
    messages,
    sendMessage,
    status: 'ready',
    regenerate: mock(),
    stop: mock(),
    append: mock(),
    reload: mock(),
    setMessages: mock(),
    setData: mock(),
    setStatus: mock(),
    _originalSendMessage: originalSendMessage,
  } as unknown as Chat<ThunderboltUIMessage> & { _originalSendMessage: ReturnType<typeof mock> }
}

/**
 * Default mode used when selectedMode is null but a session needs to be created
 */
const defaultTestMode: Mode = {
  id: 'mode-chat',
  name: 'chat',
  label: 'Chat',
  icon: 'message-square',
  systemPrompt: null,
  isDefault: 1,
  order: 0,
} as Mode

/**
 * Default model used when selectedModel is null but a session needs to be created
 */
const defaultTestModel: Model = {
  id: 'default-model',
  provider: 'openai',
  name: 'Default Model',
  model: 'gpt-4',
  isSystem: 0,
  enabled: 1,
  isConfidential: 0,
} as Model

/**
 * Hydrates the store with a session for testing
 */
export const hydrateStore = (state: {
  chatInstance: Chat<ThunderboltUIMessage> | null
  chatThread: ChatThread | null
  id: string
  workspaceId?: string
  mcpClients?: unknown[]
  modes?: Mode[]
  models?: Model[]
  selectedMode?: Mode | null
  selectedModel: Model | null
  triggerData: AutomationRun | null
}) => {
  const store = useChatStore.getState()

  // Set modes first (needed for setSelectedMode)
  if (state.modes) {
    store.setModes(state.modes)
  }

  // Set models first (needed for setSelectedModel)
  if (state.models) {
    store.setModels(state.models)
  }

  // Set MCP clients getter. Tests pass a static array; wrap it so the store's
  // `getMcpClients()` returns it (mirrors the provider's live getter in prod).
  if (state.mcpClients) {
    const clients = state.mcpClients as never[]
    store.setGetMcpClients(() => clients)
  }

  // Create or update session - use defaults if selectedMode/Model is null
  if (state.id && state.chatInstance) {
    const sessionData = {
      chatInstance: state.chatInstance,
      chatThread: state.chatThread,
      connectionStatus: 'idle' as const,
      connectionError: null,
      id: state.id,
      workspaceId: state.workspaceId ?? '00000000-0000-0000-0000-000000000001',
      pendingPermission: null,
      retryCount: 0,
      retriesExhausted: false,
      selectedAgent: builtInAgent,
      selectedMode: state.selectedMode ?? defaultTestMode,
      selectedModel: state.selectedModel ?? defaultTestModel,
      triggerData: state.triggerData,
    }

    // If session already exists, update it; otherwise create it
    if (store.sessions.has(state.id)) {
      store.updateSession(state.id, sessionData)
    } else {
      store.createSession(sessionData)
    }
    store.setCurrentSessionId(state.id)
  }
}

/**
 * Resets the store to initial state for testing
 */
export const resetStore = () => {
  // The per-agent adapter cache is module-global, so a fresh test must forget
  // any connection a prior test opened — otherwise a cache hit would suppress
  // the next test's injected `connectToAgent`.
  clearAdapterCache()
  useChatStore.setState({
    currentSessionId: null,
    getMcpClients: () => [],
    modes: [],
    models: [],
    sessions: new Map(),
  })
}

/**
 * Gets the current session from the store
 */
export const getCurrentSession = () => {
  const { currentSessionId, sessions } = useChatStore.getState()
  return currentSessionId ? sessions.get(currentSessionId) : null
}
