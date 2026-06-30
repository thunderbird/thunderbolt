/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase, useHttpClient } from '@/contexts'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import {
  composeAllAgents,
  getAllAgents,
  getAllModes,
  getAllSystemAgents,
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSelectedMode,
  getSettings,
  getTriggerPromptForThread,
  isChatThreadDeleted,
  saveMessagesWithContextUpdate,
} from '@/dal'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { selectBuiltInAgentEnabled, useConfigStore } from '@/api/config-store'
import { builtInAgent } from '@/defaults/agents'
import { markChatReady } from '@/lib/init-timing'
import { useMCP } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatStore } from './chat-store'
import { createChatInstance } from './chat-instance'
import { prewarmSystemModel } from '@/ai/fetch'

type UseHydrateChatStoreParams = {
  id: string
  isNew: boolean
}

/**
 * Reports the time from navigation start until the first chat is usable
 * (startup telemetry). Fires at most once per app session.
 */
const trackChatReadyOnce = () => {
  const chatReadyMs = markChatReady()
  if (chatReadyMs !== null) {
    trackEvent('app_chat_ready', { chat_ready_ms: Math.round(chatReadyMs) })
  }
}

/**
 * Warm the Tinfoil system enclave off the critical path so the first send skips
 * the attestation handshake. Built-in agent only — ACP agents route over the
 * wire and never touch the local model pipeline, so it's a no-op for them (and
 * {@link prewarmSystemModel} further no-ops unless `model` is a Tinfoil *system*
 * model). Fire-and-forget.
 */
const maybePrewarmBuiltInAgent = (agent: Agent, model: Model) => {
  if (agent.type === 'built-in') {
    void prewarmSystemModel(model)
  }
}

export const useHydrateChatStore = ({ id, isNew }: UseHydrateChatStoreParams) => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const getProxyFetch = useProxyFetchGetter()
  const navigate = useNavigate()

  const [isReady, setIsReady] = useState(false)

  const { getEnabledClients, reconnectClient } = useMCP()

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

    // Fetch thread info to check if we need to generate a title.
    // Pass `selectedAgent.id` so a brand-new thread is created with the user's
    // currently-selected agent — otherwise the row would default to `null`
    // and a reload would silently fall back to the built-in agent.
    const thread = await getOrCreateChatThread(db, id, session.selectedModel.id, session.selectedAgent.id)

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
    const { createSession, sessions, setCurrentSessionId, setGetMcpClients, setReconnectClient, setModes, setModels } =
      useChatStore.getState()

    // Check if this ID belongs to a deleted chat - redirect to 404 if so
    const isDeleted = await isChatThreadDeleted(db, id)
    if (isDeleted) {
      navigate('/not-found', { replace: true })
      return
    }

    // If the session already exists, set the current session id and update the mcp clients and models
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const [modes, models] = await Promise.all([getAllModes(db), getAvailableModels(db)])

      // Store the provider's getter (not a snapshot) so each send reads the
      // current connected clients, including any swapped in by a reconnect.
      setGetMcpClients(getEnabledClients)
      setReconnectClient(reconnectClient)
      setModes(modes)
      setModels(models)

      setIsReady(true)
      trackChatReadyOnce()
      // `sessions.has(id)` above guarantees the session is present.
      const existingSession = sessions.get(id)!
      maybePrewarmBuiltInAgent(existingSession.selectedAgent, existingSession.selectedModel)

      return
    }

    // If the session does not exist, create it below
    const settings = await getSettings(db, { selected_model: String, selected_agent: String })

    const [
      defaultModel,
      selectedMode,
      chatThread,
      initialMessages,
      modes,
      models,
      triggerData,
      customAgentRows,
      systemAgentRows,
    ] = await Promise.all([
      getDefaultModelForThread(db, id, settings.selectedModel ?? undefined),
      getSelectedMode(db),
      getChatThread(db, id),
      getChatMessages(db, id),
      getAllModes(db),
      getAvailableModels(db),
      getTriggerPromptForThread(db, id),
      getAllAgents(db),
      getAllSystemAgents(db),
    ])

    // Built-in is implicit (lives in code); the DB rows are only customs + system.
    // Respect the deployment's `disableBuiltInAgent` flag so the resolved agent
    // and the dropdown agree on whether the built-in exists.
    const includeBuiltIn = selectBuiltInAgentEnabled(useConfigStore.getState().config)
    const allAgents = composeAllAgents(
      systemAgentRows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        transport: row.transport,
        url: row.url,
        description: row.description,
        icon: row.icon,
        isSystem: 1 as const,
        enabled: 1 as const,
        deletedAt: null,
        userId: null,
      })),
      customAgentRows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        transport: row.transport,
        url: row.url,
        description: row.description,
        icon: row.icon,
        isSystem: 0 as const,
        enabled: row.enabled === 1 ? (1 as const) : (0 as const),
        deletedAt: row.deletedAt,
        userId: row.userId,
      })),
      { includeBuiltIn },
    )
    // Resolve the thread's persisted agent. When it no longer resolves (deleted
    // custom, unsynced system, or built-in disabled by the deployment) fall back
    // to the user's last-used agent (the global `selected_agent` setting), so a
    // new chat defaults to it rather than always the first/built-in agent. Both
    // fall back to the first available agent — silently, so enterprise users who
    // never had the built-in just continue with their own agent. `builtInAgent`
    // is the last-resort safety net for the degenerate zero-agent deployment.
    const findAgent = (agentId: string | null | undefined) =>
      agentId ? allAgents.find((a) => a.id === agentId) : undefined
    const selectedAgent =
      findAgent(chatThread?.agentId) ?? findAgent(settings.selectedAgent) ?? allAgents[0] ?? builtInAgent

    // If chat doesn't exist and this isn't a new chat, redirect to 404
    if (!chatThread && !isNew) {
      navigate('/not-found', { replace: true })
      return
    }

    const chatInstance = createChatInstance(
      id,
      initialMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
      saveMessages,
      httpClient,
      getProxyFetch,
    )

    createSession({
      chatInstance,
      chatThread,
      connectionStatus: 'idle',
      connectionError: null,
      id,
      pendingPermission: null,
      retryCount: 0,
      retriesExhausted: false,
      // Persisted via `chatThreads.agentId`; resolved above (first available
      // agent when the persisted id no longer matches).
      selectedAgent,
      selectedMode,
      selectedModel: defaultModel,
      triggerData,
    })

    setCurrentSessionId(id)

    // Store the provider's getter (not a snapshot) so each send reads the
    // current connected clients, including any swapped in by a reconnect.
    setGetMcpClients(getEnabledClients)
    setReconnectClient(reconnectClient)
    setModes(modes)
    setModels(models)

    setIsReady(true)
    trackChatReadyOnce()
    maybePrewarmBuiltInAgent(selectedAgent, defaultModel)
  }

  return { hydrateChatStore, isReady, saveMessages }
}
