import { createAcpClient } from '@/acp/client'
import { createBuiltInAgent } from '@/acp/built-in-agent'
import { createInProcessStreams } from '@/acp/streams'
import { connectToLocalAgent } from '@/acp/local-agent'
import { connectToRemoteAgent } from '@/acp/remote-agent'
import { runBuiltInPrompt } from '@/acp/run-built-in-prompt'
import { handleSessionUpdate } from './use-acp-chat'
import { useChatStore } from './chat-store'
import { isTauri, isDesktop } from '@/lib/platform'
import type { Agent, Mode, Model } from '@/types'
import type { AcpClient } from '@/acp/client'
import type { AgentSessionState } from '@/acp/types'
import type { MCPClient } from '@/lib/mcp-provider'
import { AgentSideConnection } from '@agentclientprotocol/sdk'

type CreateAcpSessionOptions = {
  chatId: string
  agent: Agent
  modes: Mode[]
  models: Model[]
  selectedModeId: string
  selectedModelId: string
  mcpClients: MCPClient[]
}

type AcpSessionResult = {
  acpClient: AcpClient
  sessionState: AgentSessionState
}

/**
 * Create an ACP session for a chat.
 * For built-in agents, creates an in-process connection with the built-in agent handler.
 * For local/remote agents, creates the appropriate transport connection.
 */
export const createAcpSession = async ({
  chatId,
  agent,
  modes,
  models,
  selectedModeId,
  selectedModelId,
  mcpClients,
}: CreateAcpSessionOptions): Promise<AcpSessionResult> => {
  // Route to appropriate transport based on agent type
  if (agent.type === 'local') {
    return createLocalAgentSession(chatId, agent)
  }

  if (agent.type === 'remote') {
    return createRemoteAgentSession(chatId, agent)
  }

  // Built-in agent: in-process streams
  const { clientStream, agentStream } = createInProcessStreams()

  // Create the built-in agent handler
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
      // Get current messages from the store for context
      const session = useChatStore.getState().sessions.get(chatId)
      const currentMessages = session?.messages ?? []

      // Find the mode's system prompt
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

  // Create the ACP client with streaming update handler
  const acpClient = createAcpClient({
    stream: clientStream,
    onSessionUpdate: (update) => {
      handleSessionUpdate(chatId, update)
    },
  })

  // Start the agent side
  new AgentSideConnection(agentHandler, agentStream)

  // Initialize and create session
  await acpClient.initialize()
  const sessionState = await acpClient.createSession()

  return { acpClient, sessionState }
}

const localAgentTimeoutMs = 15_000

/**
 * Create an ACP session for a local CLI agent (stdio transport).
 * Only available on Tauri desktop. Times out if the agent doesn't
 * respond to the ACP handshake within localAgentTimeoutMs.
 */
const createLocalAgentSession = async (chatId: string, agent: Agent): Promise<AcpSessionResult> => {
  if (!isTauri() || !isDesktop()) {
    throw new Error(`Local agent "${agent.name}" requires the desktop app.`)
  }

  const { createTauriSpawner } = await import('@/acp/tauri-spawner')
  const spawner = createTauriSpawner()

  const agentConfig = {
    id: agent.id,
    name: agent.name,
    type: agent.type as 'local',
    transport: agent.transport as 'stdio',
    command: agent.command ?? undefined,
    args: agent.args ? JSON.parse(agent.args) : undefined,
    isSystem: agent.isSystem === 1,
    enabled: agent.enabled === 1,
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Agent "${agent.name}" did not respond within ${localAgentTimeoutMs / 1000}s. Is "${agent.command}" installed and does it support ACP?`,
          ),
        ),
      localAgentTimeoutMs,
    ),
  )

  const connect = async (): Promise<AcpSessionResult> => {
    const { stream } = await connectToLocalAgent({ agentConfig, spawner })

    const acpClient = createAcpClient({
      stream,
      onSessionUpdate: (update) => {
        handleSessionUpdate(chatId, update)
      },
    })

    await acpClient.initialize()
    const sessionState = await acpClient.createSession()

    return { acpClient, sessionState }
  }

  return Promise.race([connect(), timeout])
}

/**
 * Create an ACP session for a remote agent (WebSocket transport).
 */
const createRemoteAgentSession = async (chatId: string, agent: Agent): Promise<AcpSessionResult> => {
  if (!agent.url) {
    throw new Error(`Remote agent "${agent.name}" has no URL configured.`)
  }

  const agentConfig = {
    id: agent.id,
    name: agent.name,
    type: agent.type as 'remote',
    transport: agent.transport as 'websocket',
    url: agent.url ?? undefined,
    isSystem: agent.isSystem === 1,
    enabled: agent.enabled === 1,
  }

  const { stream } = await connectToRemoteAgent({ agentConfig })

  const acpClient = createAcpClient({
    stream,
    onSessionUpdate: (update) => {
      handleSessionUpdate(chatId, update)
    },
  })

  await acpClient.initialize()
  const sessionState = await acpClient.createSession()

  return { acpClient, sessionState }
}
