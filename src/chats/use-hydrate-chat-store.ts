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
import { getAgent } from '@/dal/agents'
import { discoverAndSeedLocalAgents } from '@/acp/discovery'
import { modeFromAcpSession, modelFromAcpSession } from '@/acp/session-adapters'
import { isTauri, isDesktop, isAgentAvailableOnPlatform } from '@/lib/platform'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { useMCP } from '@/lib/mcp-provider'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { Agent, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { AgentSessionState } from '@/acp/types'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatStore, type ChatSession } from './chat-store'
import { createAcpSession, ensureAcpConnection } from './create-acp-session'

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
      // Discover local CLI agents in parallel with other queries (desktop only, no-op on web)
      discoverAndSeedLocalAgents(db).then(() => getAvailableAgents(db)),
      getTriggerPromptForThread(db, id),
      getEnabledClients(),
    ])

    // If chat doesn't exist and this isn't a new chat, redirect to 404
    if (!chatThread && !isNew) {
      navigate('/not-found', { replace: true })
      return
    }

    const initialUIMessages = initialMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]

    // For existing chats, use the agent stored on the thread rather than the global setting.
    // This ensures switching chats shows the correct agent in the selector.
    let agentForSession = selectedAgent
    if (chatThread?.agentId && chatThread.agentId !== selectedAgent.id) {
      const threadAgent = await getAgent(db, chatThread.agentId)
      if (threadAgent) {
        agentForSession = threadAgent
      }
    }

    const agentAvailable = isAgentAvailableOnPlatform(agentForSession.type)
    const isBuiltIn = agentForSession.type === 'built-in'

    // Built-in agents connect eagerly during hydration (instant, in-process).
    // Non-built-in agents create the session with null acpClient, then
    // connect eagerly in the background after the session is created.
    let acpClient: import('@/acp/client').AcpClient | null = null
    let sessionState: AgentSessionState = { sessionId: '', availableModes: [], currentModeId: null, configOptions: [] }

    if (isBuiltIn) {
      const result = await createAcpSession({
        chatId: id,
        agent: agentForSession,
        modes,
        models,
        selectedModeId: selectedMode.id,
        selectedModelId: defaultModel.id,
        mcpClients,
      })
      acpClient = result.acpClient
      sessionState = result.sessionState
    }

    // For non-built-in agents, derive mode/model from ACP session instead of DB
    const isExternalAgent = !isBuiltIn
    const sessionMode = (isExternalAgent ? modeFromAcpSession(sessionState) : null) ?? selectedMode
    const sessionModel = (isExternalAgent ? modelFromAcpSession(sessionState) : null) ?? defaultModel

    createSession({
      id,
      chatThread,
      acpClient,
      agentConfig: agentForSession,
      isAgentAvailable: agentAvailable,

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

    // Non-built-in agents that are available on this platform:
    // start connecting eagerly so mode/model selectors populate ASAP.
    if (!isBuiltIn && agentAvailable) {
      ensureAcpConnection(id)
        .then(() => {
          const { sessions, updateSession: update } = useChatStore.getState()
          const s = sessions.get(id)
          if (!s) return

          const acpSessionState: AgentSessionState = {
            sessionId: id,
            availableModes: s.availableModes,
            currentModeId: s.currentModeId,
            configOptions: s.configOptions,
          }
          const derivedMode = modeFromAcpSession(acpSessionState)
          const derivedModel = modelFromAcpSession(acpSessionState)

          const updates: Partial<ChatSession> = { status: 'ready' as const }
          if (derivedMode) updates.selectedMode = derivedMode
          if (derivedModel) updates.selectedModel = derivedModel

          update(id, updates)
        })
        .catch((err) => {
          console.error(`Eager ACP connection failed for session ${id}:`, err)
          useChatStore.getState().setSessionStatus(id, 'error', err instanceof Error ? err : new Error(String(err)))
        })
    }
  }

  return { hydrateChatStore, isReady, saveMessages }
}
