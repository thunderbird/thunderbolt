import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionMode,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { Mode, Model } from '@/types'

type BuiltInAgentDeps = {
  getModes: () => Mode[]
  getModels: () => Model[]
  getSelectedModeId: () => string
  getSelectedModelId: () => string
  onModeChange?: (modeId: string) => void
  onModelChange?: (modelId: string) => void
  runPrompt: (params: {
    sessionId: string
    text: string
    modelId: string
    modeId: string
    conn: AgentSideConnection
    abortSignal: AbortSignal
  }) => Promise<PromptResponse>
}

const modesToSessionModes = (modes: Mode[]): SessionMode[] =>
  modes.map((m) => ({
    id: m.id,
    name: m.label ?? m.name,
    description: m.systemPrompt ? `${m.name} mode` : null,
  }))

const modelsToConfigOption = (models: Model[], selectedId: string): SessionConfigOption => ({
  id: 'model',
  name: 'Model',
  type: 'select' as const,
  category: 'model',
  currentValue: selectedId,
  options: models.map((m) => ({
    value: m.id,
    name: m.name,
    description: m.description ?? null,
  })),
})

/**
 * Create an ACP Agent handler for the built-in Thunderbolt agent.
 * This wraps the existing AI SDK streamText logic behind the ACP protocol.
 */
type BuiltInSessionState = {
  modeId: string
  modelId: string
}

export const createBuiltInAgent = (deps: BuiltInAgentDeps) => {
  const abortControllers = new Map<string, AbortController>()
  const sessions = new Map<string, BuiltInSessionState>()

  const buildSessionResponse = () => {
    const modes = deps.getModes()
    const models = deps.getModels()
    const currentModeId = deps.getSelectedModeId()
    const currentModelId = deps.getSelectedModelId()
    const sessionModes = modesToSessionModes(modes)

    return {
      modes: { currentModeId, availableModes: sessionModes },
      configOptions: [modelsToConfigOption(models, currentModelId)],
    }
  }

  const agent: (conn: AgentSideConnection) => Agent = (conn) => ({
    initialize: async (_params: InitializeRequest): Promise<InitializeResponse> => ({
      agentInfo: { name: 'Thunderbolt', version: '1.0.0' },
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: false,
        },
      },
    }),

    authenticate: async (_params: AuthenticateRequest): Promise<AuthenticateResponse> => ({}),

    newSession: async (_params: NewSessionRequest): Promise<NewSessionResponse> => {
      const sessionId = crypto.randomUUID()
      const response = buildSessionResponse()

      sessions.set(sessionId, {
        modeId: response.modes.currentModeId,
        modelId: deps.getSelectedModelId(),
      })

      return { sessionId, ...response }
    },

    loadSession: async (params: LoadSessionRequest): Promise<LoadSessionResponse> => {
      const session = sessions.get(params.sessionId)
      if (!session) {
        throw RequestError.resourceNotFound(params.sessionId)
      }
      return buildSessionResponse()
    },

    setSessionMode: async (params: SetSessionModeRequest): Promise<void> => {
      deps.onModeChange?.(params.modeId)
    },

    setSessionConfigOption: async (params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> => {
      if (params.configId === 'model') {
        deps.onModelChange?.(String(params.value))
      }
      const models = deps.getModels()
      const currentModelId = params.configId === 'model' ? String(params.value) : deps.getSelectedModelId()
      return {
        configOptions: [modelsToConfigOption(models, currentModelId)],
      }
    },

    prompt: async (params: PromptRequest): Promise<PromptResponse> => {
      const ac = new AbortController()
      abortControllers.set(params.sessionId, ac)

      const text = params.prompt
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')

      try {
        return await deps.runPrompt({
          sessionId: params.sessionId,
          text,
          modelId: deps.getSelectedModelId(),
          modeId: deps.getSelectedModeId(),
          conn,
          abortSignal: ac.signal,
        })
      } finally {
        abortControllers.delete(params.sessionId)
      }
    },

    cancel: async (params: CancelNotification): Promise<void> => {
      const ac = abortControllers.get(params.sessionId)
      ac?.abort()
      abortControllers.delete(params.sessionId)
    },
  })

  return agent
}
