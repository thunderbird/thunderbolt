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
import { useMCP } from '@/lib/mcp-provider'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatStore } from './chat-store'
import { createChatInstance } from './chat-instance'

type UseHydrateChatStoreParams = {
  id: string
  isNew: boolean
}

export const useHydrateChatStore = ({ id, isNew }: UseHydrateChatStoreParams) => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const getProxyFetch = useProxyFetchGetter()
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
    const { createSession, sessions, setCurrentSessionId, setMcpClients, setModes, setModels } = useChatStore.getState()

    // Check if this ID belongs to a deleted chat - redirect to 404 if so
    const isDeleted = await isChatThreadDeleted(db, id)
    if (isDeleted) {
      navigate('/not-found', { replace: true })
      return
    }

    // If the session already exists, set the current session id and update the mcp clients and models
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const [modes, models, mcpClients] = await Promise.all([
        getAllModes(db),
        getAvailableModels(db),
        getEnabledClients(),
      ])

      setMcpClients(mcpClients)
      setModes(modes)
      setModels(models)

      setIsReady(true)

      return
    }

    // If the session does not exist, create it below
    const settings = await getSettings(db, { selected_model: String })

    const [
      defaultModel,
      selectedMode,
      chatThread,
      initialMessages,
      modes,
      models,
      triggerData,
      mcpClients,
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
      getEnabledClients(),
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
    // to the first available agent — silently, so enterprise users who never had
    // the built-in just continue with their own agent. `builtInAgent` is the
    // last-resort safety net for the degenerate zero-agent deployment.
    const persistedAgentId = chatThread?.agentId ?? null
    const selectedAgent =
      (persistedAgentId ? allAgents.find((a) => a.id === persistedAgentId) : undefined) ?? allAgents[0] ?? builtInAgent

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

    setMcpClients(mcpClients)
    setModes(modes)
    setModels(models)

    setIsReady(true)
  }

  return { hydrateChatStore, isReady, saveMessages }
}
