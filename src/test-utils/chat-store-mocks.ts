import { useChatStore, type ChatSession, type ChatStatus } from '@/chats/chat-store'
import type { AcpClient } from '@/acp/client'
import type { Agent, AutomationRun, ChatThread, Mode, Model, ThunderboltUIMessage } from '@/types'
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
 * Creates a mock AcpClient for testing
 */
export const createMockAcpClient = (): AcpClient =>
  ({
    connection: {},
    initialize: mock(() => Promise.resolve({ protocolVersion: 1, agentInfo: { name: 'Test', version: '1.0.0' } })),
    createSession: mock(() =>
      Promise.resolve({
        sessionId: 'test-session',
        availableModes: [],
        currentModeId: null,
        configOptions: [],
      }),
    ),
    prompt: mock(() => Promise.resolve({ stopReason: 'end_turn' })),
    setMode: mock(() => Promise.resolve()),
    setConfigOption: mock(() => Promise.resolve({ configOptions: [] })),
    cancel: mock(() => Promise.resolve()),
    getSessionState: mock(() => null),
    signal: new AbortController().signal,
    closed: new Promise(() => {}),
  }) as unknown as AcpClient

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
 * Default agent used when selectedAgent is not specified
 */
const defaultTestAgent: Agent = {
  id: 'default-agent',
  name: 'Test Agent',
  type: 'built-in',
  transport: 'in-process',
  command: null,
  args: null,
  url: null,
  authMethod: null,
  icon: 'zap',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

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
  acpClient?: AcpClient | null
  chatThread: ChatThread | null
  id: string
  messages?: ThunderboltUIMessage[]
  status?: ChatStatus
  error?: Error | null
  mcpClients?: unknown[]
  selectedMode?: Mode | null
  selectedModel: Model | null
  triggerData: AutomationRun | null
}) => {
  const store = useChatStore.getState()

  // Set MCP clients
  if (state.mcpClients) {
    store.setMcpClients(state.mcpClients as never[])
  }

  const acpClient = state.acpClient ?? createMockAcpClient()

  // Create or update session
  if (state.id) {
    const sessionData: ChatSession = {
      id: state.id,
      chatThread: state.chatThread,
      acpClient,
      agentConfig: defaultTestAgent,
      isAgentAvailable: true,

      availableModes: [],
      currentModeId: null,
      configOptions: [],

      messages: state.messages ?? [],
      status: state.status ?? 'ready',
      error: state.error ?? null,

      selectedMode: state.selectedMode ?? defaultTestMode,
      selectedModel: state.selectedModel ?? defaultTestModel,

      retryCount: 0,
      retriesExhausted: false,
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
  useChatStore.setState({
    currentSessionId: null,
    agents: [],
    mcpClients: [],
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
