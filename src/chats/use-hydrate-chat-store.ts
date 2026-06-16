/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase, useHttpClient } from '@/contexts'
import { getActiveWorkspaceId, useActiveWorkspaceId } from '@/lib/active-workspace'
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
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useWorkspaceNavigate } from '@/lib/active-workspace'
import { useChatStore } from './chat-store'
import { createChatInstance } from './chat-instance'

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

export const useHydrateChatStore = ({ id, isNew }: UseHydrateChatStoreParams) => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const httpClient = useHttpClient()
  const getProxyFetch = useProxyFetchGetter()
  const navigate = useNavigate()
  const workspaceNavigate = useWorkspaceNavigate()

  const [isReady, setIsReady] = useState(false)

  const { getEnabledClients, reconnectClient } = useMCP()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string, workspaceId: string) => {
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
    await updateChatThread(db, workspaceId, threadId, { title })
  }

  const saveMessages: SaveMessagesFunction = async ({ id, messages }) => {
    // Resolve workspaceId at call time rather than relying on the hook's
    // closure-captured value, which may be stale on the first render before
    // `useActiveWorkspaceId`'s React Query has resolved. The async getter
    // reads the trust-domain registry + DB synchronously w.r.t. React's
    // render lifecycle, so it's deterministic in tests.
    const workspaceId = await getActiveWorkspaceId(db)
    if (!workspaceId) {
      throw new Error('No active workspace')
    }
    const { sessions, updateSession } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    // Fetch thread info to check if we need to generate a title.
    // Pass `selectedAgent.id` so a brand-new thread is created with the user's
    // currently-selected agent — otherwise the row would default to `null`
    // and a reload would silently fall back to the built-in agent.
    const thread = await getOrCreateChatThread(db, workspaceId, id, session.selectedModel.id, session.selectedAgent.id)

    // Save messages and update context size using DAL
    await saveMessagesWithContextUpdate(db, workspaceId, id, messages)

    // Generate title in background if needed
    if (thread?.title === 'New Chat') {
      updateThreadTitle(messages, id, workspaceId)
    }

    if (!session.chatThread) {
      updateSession(id, { chatThread: thread })
      workspaceNavigate(`/chats/${id}`)
    }
  }

  const hydrateChatStore = async () => {
    // Resolve workspaceId at call time rather than relying on the hook's
    // closure-captured value. `useActiveWorkspaceId` may briefly return null
    // on the first render (race between WorkspaceGate and React Query's
    // resolution). The async getter reads the trust-domain registry + DB
    // directly, so it's deterministic regardless of React render timing —
    // which also means tests don't need to flush React Query before calling.
    const workspaceId = await getActiveWorkspaceId(db)
    if (!workspaceId) {
      return
    }
    const { createSession, sessions, setCurrentSessionId, setGetMcpClients, setReconnectClient, setModes, setModels } =
      useChatStore.getState()

    // Check if this ID belongs to a deleted chat - redirect to 404 if so
    const isDeleted = await isChatThreadDeleted(db, workspaceId, id)
    if (isDeleted) {
      navigate('/not-found', { replace: true })
      return
    }

    // If the session already exists, reuse it — unless it was built for a different
    // workspace (workspace switch). In that case, evict it so the full create path
    // rebuilds the closures with the new workspaceId.
    const existingSession = sessions.get(id)
    if (existingSession) {
      if (existingSession.workspaceId !== workspaceId) {
        // Drop `isReady` before we evict so consumers don't render against a
        // session we've just removed during the async rebuild below — they'd
        // see `isReady=true` with no matching session entry and throw
        // missing-session errors.
        setIsReady(false)
        const nextSessions = new Map(sessions)
        nextSessions.delete(id)
        useChatStore.setState({ sessions: nextSessions })
        // fall through to full create path
      } else {
        setCurrentSessionId(id)

        const [modes, models] = await Promise.all([getAllModes(db, workspaceId), getAvailableModels(db, workspaceId)])

        // Store the provider's getter (not a snapshot) so each send reads the
        // current connected clients, including any swapped in by a reconnect.
        setGetMcpClients(getEnabledClients)
        setReconnectClient(reconnectClient)
        setModes(modes)
        setModels(models)

        setIsReady(true)
        trackChatReadyOnce()
        return
      }
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
      getDefaultModelForThread(db, workspaceId, id, settings.selectedModel ?? undefined),
      getSelectedMode(db, workspaceId),
      getChatThread(db, workspaceId, id),
      getChatMessages(db, workspaceId, id),
      getAllModes(db, workspaceId),
      getAvailableModels(db, workspaceId),
      getTriggerPromptForThread(db, workspaceId, id),
      getAllAgents(db, workspaceId),
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

    // Re-read the session map immediately before the write. The top-of-function
    // existing-session check (above) is separated from `createSession` by the
    // big Promise.all, so two concurrent hydrations for the same `id` can both
    // pass the early dedup and race to `createSession` — which throws when
    // both reach it. Surfaces when `[id, workspaceId]` flips twice in quick
    // succession (e.g. landing on `/w/<newId>/chats/new` right after workspace
    // creation, where `useActiveWorkspaceId()` is briefly null then resolves).
    if (useChatStore.getState().sessions.has(id)) {
      setCurrentSessionId(id)
      setGetMcpClients(getEnabledClients)
      setReconnectClient(reconnectClient)
      setModes(modes)
      setModels(models)
      setIsReady(true)
      return
    }

    const chatInstance = createChatInstance(
      id,
      workspaceId,
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
      workspaceId,
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
  }

  return { hydrateChatStore, isReady, saveMessages, workspaceId }
}
