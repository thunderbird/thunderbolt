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
import { discoverAndSeedRemoteAgents } from '@/acp/discovery'
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
import { createAcpSession, ensureAcpConnection as ensureAcpConnection_default } from './create-acp-session'

/**
 * Compute which agents are unavailable on the current platform.
 * On web/mobile, local agents can't run but should still appear (disabled) in the UI
 * so the agent selector can indicate which agent a chat belongs to.
 */
const getUnavailableAgentIds = (agents: Agent[]): Set<string> => {
  if (isTauri() && isDesktop()) {
    return new Set()
  }
  return new Set(agents.filter((a) => !isAgentAvailableOnPlatform(a.type)).map((a) => a.id))
}

type UseHydrateChatStoreParams = {
  id: string
  isNew: boolean
  /** Injectable for testing — defaults to the real ensureAcpConnection */
  ensureAcpConnection?: typeof ensureAcpConnection_default
}

export const useHydrateChatStore = ({
  id,
  isNew,
  ensureAcpConnection = ensureAcpConnection_default,
}: UseHydrateChatStoreParams) => {
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
      setAgents(allAgents, getUnavailableAgentIds(allAgents))

      setIsReady(true)

      return
    }

    // If the session does not exist, create it below
    const settings = await getSettings(db, { selected_model: String, cloud_url: 'http://localhost:8000/v1' })

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
      // Discover remote agents and get available agents
      discoverAndSeedRemoteAgents(db, settings.cloudUrl).then(() => getAvailableAgents(db)),
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
    // Fall back to first available agent if no selected agent (e.g. when enabled types exclude built-in).
    const fallbackAgent = selectedAgent ?? agents[0]
    if (!fallbackAgent) {
      console.error('No agents available — check VITE_ENABLED_AGENT_TYPES and agent configuration')
      return
    }

    const threadAgentOverride =
      chatThread?.agentId && chatThread.agentId !== fallbackAgent.id ? await getAgent(db, chatThread.agentId) : null

    const agentForSession = threadAgentOverride ?? fallbackAgent

    const agentAvailable = isAgentAvailableOnPlatform(agentForSession.type)
    const isBuiltIn = agentForSession.type === 'built-in'

    // Built-in agents connect eagerly during hydration (instant, in-process).
    // Non-built-in agents create the session with null acpClient, then
    // connect eagerly in the background after the session is created.
    const emptySessionState: AgentSessionState = {
      sessionId: '',
      availableModes: [],
      currentModeId: null,
      configOptions: [],
    }

    const { acpClient, sessionState } = isBuiltIn
      ? await createAcpSession({
          chatId: id,
          agent: agentForSession,
          modes,
          models,
          selectedModeId: selectedMode.id,
          selectedModelId: defaultModel.id,
          mcpClients,
        })
      : { acpClient: null, sessionState: emptySessionState }

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
      acpSessionId: sessionState.sessionId || null,
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
    setAgents(agents, getUnavailableAgentIds(agents))

    setIsReady(true)

    // Non-built-in agents that are available on this platform:
    // start connecting eagerly so mode/model selectors populate ASAP.
    if (!isBuiltIn && agentAvailable) {
      void (async () => {
        try {
          await ensureAcpConnection(id)

          const { sessions, updateSession: update } = useChatStore.getState()
          const s = sessions.get(id)
          if (!s) {
            return
          }

          const acpSessionState: AgentSessionState = {
            sessionId: id,
            availableModes: s.availableModes,
            currentModeId: s.currentModeId,
            configOptions: s.configOptions,
          }
          const derivedMode = modeFromAcpSession(acpSessionState)
          const derivedModel = modelFromAcpSession(acpSessionState)

          const updates: Partial<ChatSession> = { status: 'ready' as const }
          if (derivedMode) {
            updates.selectedMode = derivedMode
          }
          if (derivedModel) {
            updates.selectedModel = derivedModel
          }

          update(id, updates)
        } catch (err) {
          console.error(`Eager ACP connection failed for session ${id}:`, err)
          const error = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
          useChatStore.getState().setSessionStatus(id, 'error', error)
        }
      })()
    }
  }

  return { hydrateChatStore, isReady, saveMessages }
}
