/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultChatTitle } from '@/lib/constants'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import {
  composeAllAgents,
  getAllAgents,
  getAllSystemAgents,
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSelectedModel,
  getSettings,
  getTriggerPromptForThread,
  isChatThreadDeleted,
  saveMessagesWithContextUpdate,
  saveStreamingAssistantMessage,
} from '@/dal'
import { customRowToAgent, systemRowToAgent } from '@/dal/agents'
import { isCloudAgent, isHostedAgent, isPortableAgent } from '@/defaults/agents'
import { portableAgentResourceId, cloudAgentToAgent, cloudAgentSelectionId } from '@/cloud-agent/agent-inventory'
import { createCloudAgentClient, type CloudConversationView } from '@/cloud-agent/client'
import { createCloudOfflineStore } from '@/cloud-agent/offline'
import { persistCloudConversation, sortCloudChatMessages, resumeCloudChat } from '@/cloud-agent/chat-history'
import { isCloudRunActive } from '@/cloud-agent/protocol'
import { HttpError } from '@/lib/http'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { selectBuiltInAgentEnabled, useConfigStore } from '@/api/config-store'
import { markChatReady } from '@/lib/init-timing'
import { useMCP } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import { generateTitle, titleSourceText } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, SaveStreamingMessageFunction, ThunderboltUIMessage } from '@/types'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatStore } from './chat-store'
import { withChatThreadWrite } from './chat-thread-write'
import { createChatInstance } from './chat-instance'
import { resolveSessionAgent } from './resolve-session-agent'
import { resolveSessionModel } from './resolve-session-model'
import { prewarmAgentModel } from '@/ai/prewarm-system-model'

type UseHydrateChatStoreParams = {
  id: string
  isNew: boolean
  selectedAgentId?: string | null
  cloudAgentId?: string | null
  /** Project a brand-new chat starts in, taken from `?projectId=` by the route.
   *  Passed in rather than read from `window.location` so the value is part of
   *  this hook's inputs and can be tested. */
  projectId?: string | null
  /** Mini App a brand-new chat starts from. Same lazy-write reasoning as
   *  `projectId`: the app is known when the panel opens, but nothing is
   *  persisted until the first message. */
  miniAppId?: string | null
  /**
   * Whether the first save should navigate to `/chats/<id>`.
   *
   * True for the chat route, where the URL must move off `/chats/new` so the
   * thread is linkable and survives reload.
   *
   * A host that supplies this takes over: nothing navigates, and recording the
   * new id is entirely its business. That is what the Mini App side panel needs
   * — navigating there would unmount the host page mid-send, taking the app, its
   * bridge, and the context the model was about to be asked about with it.
   *
   * One prop rather than a `navigateOnCreate` flag beside it: the two always
   * moved together, and the combination that made no sense (suppress the
   * navigation, supply no callback) silently created a real row that nothing
   * recorded.
   */
  onCreated?: (chatThreadId: string) => void
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

export const useHydrateChatStore = (
  {
    id,
    isNew,
    selectedAgentId = null,
    cloudAgentId = null,
    projectId: newChatProjectId = null,
    miniAppId: newChatMiniAppId = null,
    onCreated,
  }: UseHydrateChatStoreParams,
  deps: { createCloudClient?: typeof createCloudAgentClient } = {},
) => {
  const db = useDatabase()
  const auth = useAuth()
  const { data: authSession } = auth.useSession()
  const ownerId = authSession && !authSession.user.isAnonymous ? authSession.user.id : null
  const httpClient = useHttpClient()
  const getProxyFetch = useProxyFetchGetter()
  const navigate = useNavigate()

  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const { getEnabledClients, reconnectClient } = useMCP()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string) => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user')
    if (!firstUserMessage) {
      return
    }

    const textContent = titleSourceText(firstUserMessage)

    if (!textContent) {
      return
    }

    const title = generateTitle(textContent)
    await updateChatThread(db, threadId, { title })
  }

  const saveMessages: SaveMessagesFunction = async ({ id, messages }) => {
    const { updateSession } = useChatStore.getState()
    // Read the session inside the queue so a move that ran before creation is
    // included in the insert; a later move waits until the row exists.
    const { session, thread } = await withChatThreadWrite(id, async () => {
      const { sessions } = useChatStore.getState()

      const session = sessions.get(id)

      if (!session) {
        throw new Error('No session found')
      }

      // Fetch thread info to check if we need to generate a title.
      // Pass `selectedAgent.id` so a brand-new thread is created with the user's
      // currently-selected agent — otherwise the row would default to `null`
      // and a reload would silently fall back to the built-in agent.
      const thread = await getOrCreateChatThread(db, id, session.selectedModel.id, {
        agentId: session.selectedAgent.id,
        // Stamped here rather than at navigation time: the row is created lazily
        // on this first save, so both must ride the session to reach it.
        projectId: session.projectId,
        miniAppId: session.miniAppId,
        // The hosted agent sends the chat to the backend unencrypted, so its threads
        // are never private chats, whatever the (unused) selected model is.
        isEncrypted: isHostedAgent(session.selectedAgent) || isCloudAgent(session.selectedAgent) ? 0 : undefined,
      })
      return { session, thread }
    })

    // Save messages and update context size using DAL
    if (isCloudAgent(session.selectedAgent)) {
      // Cloud message IDs are durable command/run IDs, not time-ordered UUIDs.
      // Preserve the displayed parent chain instead of inferring it from MAX(id).
      const ordered = session.chatInstance.messages
      for (const message of messages) {
        const index = ordered.findIndex((candidate) => candidate.id === message.id)
        await saveStreamingAssistantMessage(db, id, message, index > 0 ? ordered[index - 1].id : null)
      }
    } else {
      await saveMessagesWithContextUpdate(db, id, messages)
    }

    // Generate title in background if needed
    if (thread?.title === defaultChatTitle) {
      updateThreadTitle(messages, id)
    }

    if (!session.chatThread) {
      updateSession(id, { chatThread: thread })
      if (onCreated) {
        // The host records the id its own way, and stays where it is.
        onCreated(id)
      } else {
        navigate(`/chats/${id}`, { relative: 'path' })
      }
    }
  }

  /**
   * Crash-recovery save for the in-flight assistant message during streaming.
   * Deliberately bypasses {@link saveMessages}: the thread already exists and is
   * navigated to by the time the assistant streams, so the thread create / title
   * / navigation work — and the DAL's redundant thread + last-message SELECTs —
   * are all avoidable per token. The authoritative complete save runs in the
   * chat instance's `onFinish` via {@link saveMessages}.
   */
  // Stable identity (deps: the stable `db` context value) so it can sit in the
  // partial-save effect's dependency array without re-firing on every parent
  // render — otherwise an on-screen error terminal would re-run the direct
  // error-save (a redundant idempotent upsert + E2EE encrypt/upload) per render.
  const saveStreamingMessage: SaveStreamingMessageFunction = useCallback(
    async ({ threadId, message, parentId }) => {
      await saveStreamingAssistantMessage(db, threadId, message, parentId)
    },
    [db],
  )

  const hydrateChatStore = async () => {
    const { createSession, sessions, setCurrentSessionId, setGetMcpClients, setReconnectClient, setModels } =
      useChatStore.getState()

    // Check if this ID belongs to a deleted chat - redirect to 404 if so
    const isDeleted = !isNew && (await isChatThreadDeleted(db, id))
    if (isDeleted) {
      navigate('/not-found', { replace: true })
      return
    }

    // If the session already exists, set the current session id and update the mcp clients and models
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const models = await getAvailableModels(db)

      // Store the provider's getter (not a snapshot) so each send reads the
      // current connected clients, including any swapped in by a reconnect.
      setGetMcpClients(getEnabledClients)
      setReconnectClient(reconnectClient)
      setModels(models)

      setIsReady(true)
      trackChatReadyOnce()
      // `sessions.has(id)` above guarantees the session is present.
      const existingSession = sessions.get(id)!
      void prewarmAgentModel(existingSession.selectedAgent, existingSession.selectedModel)

      return
    }

    // New IDs are minted locally and have no history. Read the selected model
    // directly, and start independent reads together instead of gating on settings.
    const [
      settings,
      defaultModel,
      storedThread,
      initialMessages,
      models,
      triggerData,
      customAgentRows,
      systemAgentRows,
    ] = await Promise.all([
      getSettings(db, { selected_model: String, selected_agent: String }),
      isNew ? getSelectedModel(db) : getDefaultModelForThread(db, id),
      isNew ? null : getChatThread(db, id),
      isNew ? [] : getChatMessages(db, id),
      getAvailableModels(db),
      isNew ? null : getTriggerPromptForThread(db, id),
      getAllAgents(db),
      getAllSystemAgents(db),
    ])

    const requestedAgentId = isNew ? (selectedAgentId ?? settings.selectedAgent) : storedThread?.agentId
    if (/^(cloud|local):/.test(requestedAgentId ?? '') && !portableAgentResourceId(requestedAgentId)) {
      throw new Error(i18n._(msg`This cloud agent selection is invalid. Choose an agent again.`))
    }
    const cloudResourceId = isNew
      ? portableAgentResourceId(selectedAgentId ?? settings.selectedAgent)
      : (portableAgentResourceId(storedThread?.agentId) ?? (!storedThread ? cloudAgentId : null))
    if (storedThread && cloudAgentId && storedThread.agentId !== cloudAgentSelectionId(cloudAgentId)) {
      throw new Error(i18n._(msg`This cloud conversation does not belong to the selected chat.`))
    }
    const cloudClient =
      cloudResourceId && ownerId
        ? (deps.createCloudClient ?? createCloudAgentClient)(httpClient, ownerId, createCloudOfflineStore(db, ownerId))
        : null
    if (cloudResourceId && !cloudClient) {
      throw new Error(i18n._(msg`Sign in and unlock encrypted sync to open this cloud agent.`))
    }
    const cloudView = cloudClient
      ? (await cloudClient.agents()).find(({ record }) => record.id === cloudResourceId && record.ownerId === ownerId)
      : undefined
    if (cloudResourceId && !cloudView) {
      throw new Error(i18n._(msg`This cloud agent is unavailable. Your chat has not been sent to another agent.`))
    }
    const loadProjection = async (): Promise<CloudConversationView | null> => {
      if (isNew || requestedAgentId?.startsWith('local:') || !cloudClient || !cloudView) {
        return null
      }
      try {
        return await cloudClient.getConversation(cloudView.record, id)
      } catch (error) {
        // The first local save can precede conversation creation. Retrying that
        // original command is safe; a deep link without a local row must exist.
        if (storedThread && error instanceof HttpError && error.response.status === 404) {
          return null
        }
        throw error
      }
    }
    const projection = await loadProjection()
    const importedThread = projection && cloudView ? await persistCloudConversation(db, cloudView, projection) : null
    const chatThread = importedThread ?? storedThread

    // Built-in is implicit (lives in code); the DB rows are only customs + system.
    // Respect the deployment's `disableBuiltInAgent` flag so the resolved agent
    // and the dropdown agree on whether the built-in exists.
    const includeBuiltIn = selectBuiltInAgentEnabled(useConfigStore.getState().config)
    const allAgents = [
      ...composeAllAgents(systemAgentRows.map(systemRowToAgent), customAgentRows.map(customRowToAgent), {
        includeBuiltIn,
      }),
      ...(cloudView ? [cloudAgentToAgent(cloudView)] : []),
    ]
    // Only a brand-new chat takes the discovered default; a persisted thread with
    // no agent of its own stays on the fallback chain. Read after the last await
    // so nothing can land between this and `createSession`. Once discovery has
    // answered, its result wins over `agents_system` rows read before it wrote or
    // cleared them; until then the cached `is_default` row stands in.
    const { agentDiscovery } = useChatStore.getState()
    const discoveredDefaultRowId = systemAgentRows.find((row) => row.isDefault === 1)?.id
    const discoveredDefaultAgent = chatThread
      ? undefined
      : agentDiscovery.status === 'done'
        ? (agentDiscovery.defaultAgent ?? undefined)
        : allAgents.find((agent) => agent.id === discoveredDefaultRowId)
    // A finished discovery's own list covers agents its write added after the read above.
    const knownAgents =
      agentDiscovery.status === 'done'
        ? [...allAgents, ...agentDiscovery.agents.filter((agent) => !allAgents.some(({ id }) => id === agent.id))]
        : allAgents
    const selectedAgent = resolveSessionAgent(knownAgents, {
      threadAgentId:
        chatThread?.agentId ?? selectedAgentId ?? (cloudAgentId ? cloudAgentSelectionId(cloudAgentId) : null),
      lastUsedAgentId: settings.selectedAgent,
      hasModelPick: !!settings.selectedModel,
      discoveredDefaultAgent,
    })
    const selectedModel = resolveSessionModel(selectedAgent, chatThread, defaultModel, models)

    // A persisted thread owns its project; a brand-new chat started from a
    // project carries it in the URL (`/chats/new?projectId=…`), which is the only
    // moment that intent exists — nothing has been written yet.
    const projectId = chatThread?.projectId ?? (isNew ? newChatProjectId : null)
    const miniAppId = chatThread?.miniAppId ?? (isNew ? newChatMiniAppId : null)

    // If chat doesn't exist and this isn't a new chat, redirect to 404
    if (!chatThread && !isNew) {
      navigate('/not-found', { replace: true })
      return
    }

    const mergedMessages = importedThread ? await getChatMessages(db, id) : initialMessages
    const initialUiMessages = sortCloudChatMessages(
      mergedMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
    )
    const chatInstance = createChatInstance(id, initialUiMessages, saveMessages, httpClient, getProxyFetch)

    const lastInitialMessage = initialUiMessages[initialUiMessages.length - 1]
    const hydratedTrailingEmptyTurn =
      lastInitialMessage?.role === 'assistant' &&
      !lastInitialMessage.metadata?.cloud &&
      !lastInitialMessage.parts?.length

    createSession({
      chatInstance,
      chatThread,
      connectionStatus: 'idle',
      connectionError: null,
      id,
      pendingPermission: null,
      miniAppApprovalQueue: [],
      retryCount: 0,
      retriesExhausted: hydratedTrailingEmptyTurn,
      stopping: false,
      // Persisted via `chatThreads.agentId`; resolved above (first available
      // agent when the persisted id no longer matches).
      selectedAgent,
      agentChosenByUser: !!selectedAgentId || !!cloudAgentId || isPortableAgent(selectedAgent),
      selectedModel,
      projectId,
      miniAppId,
      triggerData,
    })

    setCurrentSessionId(id)

    // Store the provider's getter (not a snapshot) so each send reads the
    // current connected clients, including any swapped in by a reconnect.
    setGetMcpClients(getEnabledClients)
    setReconnectClient(reconnectClient)
    setModels(models)

    setIsReady(true)
    trackChatReadyOnce()
    void prewarmAgentModel(selectedAgent, selectedModel)
    if (projection?.runs.some((run) => isCloudRunActive(run.status))) {
      await resumeCloudChat(id)
    }
  }

  const hydrate = async () => {
    setError(null)
    try {
      await hydrateChatStore()
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(String(failure)))
    }
  }

  return { hydrateChatStore: hydrate, isReady, error, saveMessages, saveStreamingMessage }
}
