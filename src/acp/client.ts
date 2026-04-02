import {
  ClientSideConnection,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type Stream,
  type InitializeResponse,
} from '@agentclientprotocol/sdk'
import type { AgentSessionState } from './types'

/** Resolve cwd for ACP sessions — agents require an absolute path. */
const getSessionCwd = async (): Promise<string> => {
  try {
    const { homeDir } = await import('@tauri-apps/api/path')
    const dir = await homeDir()
    if (typeof dir === 'string') {
      return dir
    }
    return '/'
  } catch {
    return '/'
  }
}

type SessionUpdateHandler = (update: SessionNotification['update']) => void

type AcpClientOptions = {
  stream: Stream
  onSessionUpdate?: SessionUpdateHandler
  onPermissionRequest?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
}

/**
 * Thin wrapper around ACP ClientSideConnection with Thunderbolt-specific helpers.
 */
export const createAcpClient = ({ stream, onSessionUpdate, onPermissionRequest }: AcpClientOptions) => {
  let sessionState: AgentSessionState | null = null

  const client: (agent: Agent) => Client = (_agent) => ({
    sessionUpdate: async (params: SessionNotification) => {
      const update = params.update

      // Track mode/config changes from agent
      if (update.sessionUpdate === 'current_mode_update' && sessionState) {
        sessionState.currentModeId = update.currentModeId
      }
      if (update.sessionUpdate === 'config_option_update' && sessionState) {
        sessionState.configOptions = update.configOptions
      }

      onSessionUpdate?.(update)
    },

    requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      if (onPermissionRequest) {
        return onPermissionRequest(params)
      }
      // Default: allow once
      const allowOption = params.options.find((o) => o.kind === 'allow_once')
      if (allowOption) {
        return { outcome: { outcome: 'selected' as const, optionId: allowOption.optionId } }
      }
      return { outcome: { outcome: 'cancelled' as const } }
    },
  })

  const connection = new ClientSideConnection(client, stream)

  let initializeResult: InitializeResponse | null = null

  const requireSession = (): AgentSessionState => {
    if (!sessionState) {
      throw new Error('No active session. Call createSession() first.')
    }
    return sessionState
  }

  return {
    connection,

    get supportsLoadSession() {
      return initializeResult?.agentCapabilities?.loadSession === true
    },

    initialize: async () => {
      const result = await connection.initialize({
        clientInfo: { name: 'Thunderbolt', version: '1.0.0' },
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
      initializeResult = result
      return result
    },

    createSession: async (cwd?: string): Promise<AgentSessionState> => {
      const resolvedCwd = cwd ?? (await getSessionCwd())
      const result = await connection.newSession({
        cwd: resolvedCwd,
        mcpServers: [],
      })
      sessionState = {
        sessionId: result.sessionId,
        availableModes: result.modes?.availableModes ?? [],
        currentModeId: result.modes?.currentModeId ?? null,
        configOptions: result.configOptions ?? [],
      }
      return sessionState
    },

    /** Resume a previously established session by ID. */
    loadSession: async (sessionId: string): Promise<AgentSessionState> => {
      const resolvedCwd = await getSessionCwd()
      const result = await connection.loadSession({
        sessionId,
        cwd: resolvedCwd,
        mcpServers: [],
      })
      sessionState = {
        sessionId,
        availableModes: result.modes?.availableModes ?? [],
        currentModeId: result.modes?.currentModeId ?? null,
        configOptions: result.configOptions ?? [],
      }
      return sessionState
    },

    prompt: async (text: string) => {
      const session = requireSession()
      return connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text }],
      })
    },

    setMode: async (modeId: string) => {
      const session = requireSession()
      return connection.setSessionMode({
        sessionId: session.sessionId,
        modeId,
      })
    },

    setConfigOption: async (configId: string, value: string) => {
      const session = requireSession()
      return connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId,
        value,
      })
    },

    cancel: async () => {
      if (!sessionState) {
        return
      }
      return connection.cancel({
        sessionId: sessionState.sessionId,
      })
    },

    getSessionState: () => sessionState,

    get signal() {
      return connection.signal
    },

    get closed() {
      return connection.closed
    },
  }
}

export type AcpClient = ReturnType<typeof createAcpClient>
