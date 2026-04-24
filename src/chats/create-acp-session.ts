import { createAcpClient, type AcpClient } from '@/acp/client'
import { createBuiltInAgent } from '@/acp/built-in-agent'
import { createInProcessStreams } from '@/acp/streams'
import { connectToLocalAgent } from '@/acp/local-agent'
import { connectToRemoteAgent } from '@/acp/remote-agent'
import { runBuiltInPrompt } from '@/acp/run-built-in-prompt'
import { handleSessionUpdate } from './use-acp-chat'
import { useChatStore } from './chat-store'
import { isAgentAvailableOnPlatform } from '@/lib/platform'
import { getDb } from '@/db/database'
import { getSettings } from '@/dal'
import type { Agent, Mode, Model } from '@/types'
import type { AgentConfig, AgentSessionState } from '@/acp/types'
import type { MCPClient } from '@/lib/mcp-provider'
import type { Stream } from '@agentclientprotocol/sdk'
import { AgentSideConnection } from '@agentclientprotocol/sdk'

type CreateAcpSessionOptions = {
  chatId: string
  agent: Agent
  selectedModeId: string
  selectedModelId: string
  mcpClients: MCPClient[]
  /** Only needed for built-in agents — ignored for local/remote. */
  modes?: Mode[]
  /** Only needed for built-in agents — ignored for local/remote. */
  models?: Model[]
}

type AcpSessionResult = {
  acpClient: AcpClient
  sessionState: AgentSessionState
}

/** Safely parse a JSON string, returning a fallback on malformed data. */
const safeParseArgs = (args: string | null): string[] | undefined => {
  if (!args) {
    return undefined
  }
  try {
    return JSON.parse(args)
  } catch {
    return []
  }
}

/** Convert an Agent DB row to an AgentConfig runtime object. */
const toAgentConfig = (agent: Agent): AgentConfig => ({
  id: agent.id,
  name: agent.name,
  type: agent.type as AgentConfig['type'],
  transport: agent.transport as AgentConfig['transport'],
  command: agent.command ?? undefined,
  args: safeParseArgs(agent.args),
  url: agent.url ?? undefined,
  authMethod: agent.authMethod ?? undefined,
  isSystem: agent.isSystem === 1,
  enabled: agent.enabled === 1,
  distributionType: agent.distributionType ?? undefined,
  installPath: agent.installPath ?? undefined,
  packageName: agent.packageName ?? undefined,
})

/** Create an AcpClient from a stream, wire up session updates, and perform the ACP handshake. */
const initializeAcpSession = async (stream: Stream, chatId: string): Promise<AcpSessionResult> => {
  const acpClient = createAcpClient({
    stream,
    onSessionUpdate: (update) => {
      handleSessionUpdate(chatId, update)
    },
  })

  await acpClient.initialize()
  const sessionState = await acpClient.createSession()

  // Persist the ACP sessionId on the ChatSession so it survives client replacement.
  // Only update if the session already exists in the store (built-in agents create
  // the ACP session before the store session is created).
  const existingSession = useChatStore.getState().sessions.get(chatId)
  if (existingSession) {
    useChatStore.getState().updateSession(chatId, { acpSessionId: sessionState.sessionId })
  }

  return { acpClient, sessionState }
}

/**
 * Create an ACP session for a chat.
 * For built-in agents, creates an in-process connection with the built-in agent handler.
 * For local/remote agents, creates the appropriate transport connection.
 */
export const createAcpSession = async ({
  chatId,
  agent,
  selectedModeId,
  selectedModelId,
  mcpClients,
  modes = [],
  models = [],
}: CreateAcpSessionOptions): Promise<AcpSessionResult> => {
  if (agent.type === 'local') {
    return createLocalAgentSession(chatId, agent)
  }

  if (agent.type === 'remote') {
    return createRemoteAgentSession(chatId, agent)
  }

  const { clientStream, agentStream } = createInProcessStreams()

  const agentHandler = createBuiltInAgent({
    getModes: () => modes,
    getModels: () => models,
    getSelectedModeId: () => {
      const session = useChatStore.getState().sessions.get(chatId)
      return session?.currentModeId ?? selectedModeId
    },
    getSelectedModelId: () => {
      const session = useChatStore.getState().sessions.get(chatId)
      return session?.selectedModel?.id ?? selectedModelId
    },
    onModeChange: (modeId) => {
      useChatStore.getState().updateSession(chatId, { currentModeId: modeId })
    },
    onModelChange: (modelId) => {
      const model = models.find((m) => m.id === modelId)
      if (model) {
        useChatStore.getState().updateSession(chatId, { selectedModel: model })
      }
    },
    runPrompt: async ({ sessionId, modelId, modeId, conn, abortSignal }) => {
      const session = useChatStore.getState().sessions.get(chatId)
      const allMessages = session?.messages ?? []
      // Filter out the trailing empty assistant placeholder (used for UI loading state)
      // to prevent sending it to the LLM — some providers (e.g., Mistral) reject empty assistant messages
      const currentMessages =
        allMessages.at(-1)?.role === 'assistant' && !allMessages.at(-1)?.parts.some((p) => p.type === 'text' && p.text)
          ? allMessages.slice(0, -1)
          : allMessages
      const mode = modes.find((m) => m.id === modeId)

      return runBuiltInPrompt({
        sessionId,
        messages: currentMessages,
        modelId,
        modeSystemPrompt: mode?.systemPrompt ?? undefined,
        modeName: mode?.name ?? undefined,
        conn,
        abortSignal,
        mcpClients,
      })
    },
  })

  new AgentSideConnection(agentHandler, agentStream)

  return initializeAcpSession(clientStream, chatId)
}

/**
 * Lazily ensure an ACP connection exists for a session.
 * If the session already has an acpClient, returns it immediately.
 * Otherwise creates the connection, updates the session, and returns the client.
 * Deduplicates concurrent calls for the same session.
 */
const pendingConnections = new Map<string, Promise<AcpClient>>()

export const ensureAcpConnection = async (sessionId: string): Promise<AcpClient> => {
  const store = useChatStore.getState()
  const session = store.sessions.get(sessionId)
  if (!session) {
    throw new Error('No session found')
  }

  // Already connected
  if (session.acpClient) {
    return session.acpClient
  }

  // Already connecting — dedup concurrent calls
  const pending = pendingConnections.get(sessionId)
  if (pending) {
    return pending
  }

  const connectPromise = (async () => {
    store.setSessionStatus(sessionId, 'connecting')

    const { acpClient, sessionState } = await createAcpSession({
      chatId: sessionId,
      agent: session.agentConfig,
      selectedModeId: session.currentModeId ?? session.selectedMode.id,
      selectedModelId: session.selectedModel.id,
      mcpClients: useChatStore.getState().mcpClients,
    })

    // Update session with live client and negotiated state.
    // Don't change status here — the caller (e.g. sendAcpPrompt) manages status transitions.
    store.updateSession(sessionId, {
      acpClient,
      availableModes: sessionState.availableModes,
      currentModeId: sessionState.currentModeId,
      configOptions: sessionState.configOptions,
    })

    return acpClient
  })()

  pendingConnections.set(sessionId, connectPromise)
  connectPromise.finally(() => pendingConnections.delete(sessionId))

  return connectPromise
}

const localAgentTimeoutMs = 10_000

/**
 * Create an ACP session for a local CLI agent (stdio transport).
 * Only available on Tauri desktop. Times out if the agent doesn't
 * respond to the ACP handshake within localAgentTimeoutMs.
 */
const createLocalAgentSession = async (chatId: string, agent: Agent): Promise<AcpSessionResult> => {
  if (!isAgentAvailableOnPlatform('local')) {
    throw new Error(`Local agent "${agent.name}" requires the desktop app.`)
  }

  const { createTauriSpawner } = await import('@/acp/tauri-spawner')
  const spawner = createTauriSpawner()

  const agentConfig = toAgentConfig(agent)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Agent "${agent.name}" did not respond within ${localAgentTimeoutMs / 1000}s. Is "${agent.command}" installed and does it support ACP?`,
          ),
        ),
      localAgentTimeoutMs,
    )
  })

  const connect = async (): Promise<AcpSessionResult> => {
    const { stream } = await connectToLocalAgent({ agentConfig, spawner })
    return initializeAcpSession(stream, chatId)
  }

  try {
    return await Promise.race([connect(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Build the backend proxy URL for a user-added agent. */
const getProxyUrl = async (agentId: string): Promise<string> => {
  const db = getDb()
  const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })
  const wsUrl = cloudUrl.replace(/^http/, 'ws')
  return `${wsUrl}/agent-proxy/ws/${agentId}`
}

/**
 * Create an ACP session for a remote agent (WebSocket transport).
 * System agents connect directly to their URL.
 * User-added agents are routed through the backend proxy.
 */
const createRemoteAgentSession = async (chatId: string, agent: Agent): Promise<AcpSessionResult> => {
  if (!agent.url) {
    throw new Error(`Remote agent "${agent.name}" has no URL configured.`)
  }

  const agentConfig = toAgentConfig(agent)

  // User-added agents go through the backend proxy with config in the ticket
  const isUserAgent = agent.isSystem === 0
  if (isUserAgent) {
    agentConfig.url = await getProxyUrl(agent.id)
  }

  const ticketPayload = isUserAgent ? { url: agent.url, authMethod: agent.authMethod ?? undefined } : undefined

  return new Promise<AcpSessionResult>((resolve, reject) => {
    let isFirstConnect = true

    connectToRemoteAgent({
      agentConfig,
      ticketPayload,
      onStream: async (stream) => {
        if (isFirstConnect) {
          isFirstConnect = false
          try {
            resolve(await initializeAcpSession(stream, chatId))
          } catch (err) {
            reject(err)
          }
          return
        }

        // Reconnect: create a fresh ACP client on the new stream, attempt session/load
        void handleReconnect(stream, chatId)
      },
      onDisconnected: () => {
        if (isFirstConnect) {
          isFirstConnect = false
          reject(new Error(`Failed to connect to agent "${agent.name}" — retries exhausted.`))
          return
        }

        const store = useChatStore.getState()
        store.updateSession(chatId, { acpClient: null })
        store.setSessionStatus(chatId, 'error', new Error('Connection lost — retries exhausted.'))
      },
    })
  })
}

/**
 * Handle WebSocket reconnection by creating a new ACP client and attempting
 * session resumption via loadSession, falling back to createSession.
 */
const handleReconnect = async (stream: Stream, chatId: string) => {
  const store = useChatStore.getState()
  const session = store.sessions.get(chatId)
  if (!session) {
    return
  }

  store.setSessionStatus(chatId, 'connecting')

  const acpClient = createAcpClient({
    stream,
    onSessionUpdate: (update) => {
      handleSessionUpdate(chatId, update)
    },
  })

  await acpClient.initialize()

  const previousSessionId = session.acpSessionId

  let sessionState: AgentSessionState

  if (acpClient.supportsLoadSession && previousSessionId) {
    try {
      sessionState = await acpClient.loadSession(previousSessionId)
    } catch {
      // Session not found on agent side — fall back to a fresh session
      sessionState = await acpClient.createSession()
    }
  } else {
    sessionState = await acpClient.createSession()
  }

  store.updateSession(chatId, {
    acpClient,
    acpSessionId: sessionState.sessionId,
    availableModes: sessionState.availableModes,
    currentModeId: sessionState.currentModeId,
    configOptions: sessionState.configOptions,
  })

  store.setSessionStatus(chatId, 'ready')
}
