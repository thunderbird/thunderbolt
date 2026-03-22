import { useDatabase } from '@/contexts'
import {
  getAllModes,
  getAvailableAgents,
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSelectedAgent,
  getSelectedMode,
  getSettings,
  getTriggerPromptForThread,
  isChatThreadDeleted,
  saveMessagesWithContextUpdate,
} from '@/dal'
import { discoverAndSeedLocalAgents } from '@/acp/discovery'
import { isTauri, isDesktop } from '@/lib/platform'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { useMCP } from '@/lib/mcp-provider'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { Agent, Mode, Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { AgentSessionState } from '@/acp/types'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatStore } from './chat-store'
import { createAcpSession } from './create-acp-session'

/**
 * Derive a Mode object from ACP session state for non-built-in agents.
 * Returns null if no modes are available from the agent.
 */
const modeFromAcpSession = (sessionState: AgentSessionState): Mode | null => {
  const currentId = sessionState.currentModeId
  const acpMode = sessionState.availableModes.find((m) => m.id === currentId) ?? sessionState.availableModes[0]
  if (!acpMode) {
    return null
  }
  return {
    id: acpMode.id,
    name: acpMode.id,
    label: acpMode.name,
    icon: 'terminal',
    systemPrompt: null,
    isDefault: 0,
    order: 0,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  }
}

/**
 * Derive a Model object from ACP session config options for non-built-in agents.
 * Returns null if no model config is available from the agent.
 */
const modelFromAcpSession = (sessionState: AgentSessionState): Model | null => {
  const modelConfig = sessionState.configOptions.find((o) => o.category === 'model')
  if (!modelConfig || modelConfig.type !== 'select' || !Array.isArray(modelConfig.options)) {
    return null
  }
  const currentValue = 'currentValue' in modelConfig ? String(modelConfig.currentValue) : null
  const options = modelConfig.options as Array<{ value: string; name: string; description?: string | null }>
  const opt = options.find((o) => o.value === currentValue) ?? options[0]
  if (!opt) {
    return null
  }
  return {
    id: opt.value,
    name: opt.name,
    model: opt.value,
    description: opt.description ?? null,
    vendor: null,
    contextWindow: null,
    isConfidential: 0,
    isSystem: 1,
    enabled: 1,
    deletedAt: null,
    defaultHash: null,
    userId: null,
    url: null,
    provider: 'custom',
    apiKey: null,
    toolUsage: 1,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
  }
}

/**
 * Filter out local agents on non-desktop platforms.
 * Local agents synced via PowerSync from desktop should not appear on web/mobile.
 */
const filterAgentsByPlatform = (agents: Agent[]): Agent[] => {
  if (isTauri() && isDesktop()) {
    return agents
  }
  return agents.filter((a) => a.type !== 'local')
}

type UseHydrateChatStoreParams = {
  id: string
  isNew: boolean
}

export const useHydrateChatStore = ({ id, isNew }: UseHydrateChatStoreParams) => {
  const db = useDatabase()
  const navigate = useNavigate()

  const [isReady, setIsReady] = useState(false)

  const { getEnabledClients } = useMCP()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string) => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user')
    if (!firstUserMessage) {
      return
    }

    const textContent = firstUserMessage.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')

    if (!textContent) {
      return
    }

    const title = await generateTitle(textContent)
    await updateChatThread(db, threadId, { title })
  }

  const saveMessages: SaveMessagesFunction = async ({ id, messages }) => {
    const { sessions, updateSession } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    // Fetch thread info to check if we need to generate a title
    const thread = await getOrCreateChatThread(db, id, session.selectedModel.id, session.agentConfig.id)

    // Save messages and update context size using DAL
    await saveMessagesWithContextUpdate(db, id, messages)

    // Generate title in background if needed
    if (thread?.title === 'New Chat') {
      updateThreadTitle(messages, id)
    }

    if (!session.chatThread) {
      updateSession(id, { chatThread: thread })
      navigate(`/chats/${id}`, { relative: 'path' })
    }
  }

  const hydrateChatStore = async () => {
    const { createSession, sessions, setCurrentSessionId, setAgents, setMcpClients } = useChatStore.getState()

    // Check if this ID belongs to a deleted chat - redirect to 404 if so
    const isDeleted = await isChatThreadDeleted(db, id)
    if (isDeleted) {
      navigate('/not-found', { replace: true })
      return
    }

    // If the session already exists, set the current session id and update the mcp clients
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const [allAgents, mcpClients] = await Promise.all([getAvailableAgents(db), getEnabledClients()])

      setMcpClients(mcpClients)
      setAgents(filterAgentsByPlatform(allAgents))

      setIsReady(true)

      return
    }

    // If the session does not exist, create it below
    const settings = await getSettings(db, { selected_model: String })

    // Discover local CLI agents on desktop (adds them to DB if found on PATH)
    await discoverAndSeedLocalAgents(db)

    const [
      defaultModel,
      selectedMode,
      selectedAgent,
      chatThread,
      initialMessages,
      modes,
      models,
      agents,
      triggerData,
      mcpClients,
    ] = await Promise.all([
      getDefaultModelForThread(db, id, settings.selectedModel ?? undefined),
      getSelectedMode(db),
      getSelectedAgent(db),
      getChatThread(db, id),
      getChatMessages(db, id),
      getAllModes(db),
      getAvailableModels(db),
      getAvailableAgents(db),
      getTriggerPromptForThread(db, id),
      getEnabledClients(),
    ])

    // If chat doesn't exist and this isn't a new chat, redirect to 404
    if (!chatThread && !isNew) {
      navigate('/not-found', { replace: true })
      return
    }

    const initialUIMessages = initialMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]

    // Create ACP session for this chat
    const { acpClient, sessionState } = await createAcpSession({
      chatId: id,
      agent: selectedAgent,
      modes,
      models,
      selectedModeId: selectedMode.id,
      selectedModelId: defaultModel.id,
      mcpClients,
    })

    // For non-built-in agents, derive mode/model from ACP session instead of DB
    const isExternalAgent = selectedAgent.type !== 'built-in'
    const sessionMode = (isExternalAgent ? modeFromAcpSession(sessionState) : null) ?? selectedMode
    const sessionModel = (isExternalAgent ? modelFromAcpSession(sessionState) : null) ?? defaultModel

    createSession({
      id,
      chatThread,
      acpClient,
      agentConfig: selectedAgent,

      // ACP session state
      availableModes: sessionState.availableModes,
      currentModeId: sessionState.currentModeId,
      configOptions: sessionState.configOptions,

      // Message state
      messages: initialUIMessages,
      status: 'ready',
      error: null,

      // Backward compat — for external agents, derived from ACP session
      selectedMode: sessionMode,
      selectedModel: sessionModel,

      retryCount: 0,
      retriesExhausted: false,
      triggerData,
    })

    setCurrentSessionId(id)

    setMcpClients(mcpClients)
    setAgents(filterAgentsByPlatform(agents))

    setIsReady(true)
  }

  return { hydrateChatStore, isReady, saveMessages }
}
