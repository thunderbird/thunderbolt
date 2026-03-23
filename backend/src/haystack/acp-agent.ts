import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from '@agentclientprotocol/sdk'
import type { HaystackClient } from './client'
import type { HaystackPipelineConfig } from './types'
import { parseSSE, extractReferences, extractDocuments } from './sse-parser'

type HaystackAcpAgentDeps = {
  client: HaystackClient
  pipelineConfig: HaystackPipelineConfig
}

type SessionState = {
  haystackSessionId: string
  abortController: AbortController | null
}

/**
 * Create an ACP Agent handler that wraps a Deepset/Haystack pipeline.
 * Streams chat responses via ACP session updates with _meta for citations.
 */
export const createHaystackAcpAgent = ({ client, pipelineConfig }: HaystackAcpAgentDeps) => {
  const sessions = new Map<string, SessionState>()

  const agent: (conn: AgentSideConnection) => Agent = (conn) => ({
    initialize: async (_params: InitializeRequest): Promise<InitializeResponse> => ({
      agentInfo: { name: pipelineConfig.name, version: '1.0.0' },
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
    }),

    authenticate: async (_params: AuthenticateRequest): Promise<AuthenticateResponse> => ({}),

    newSession: async (_params: NewSessionRequest): Promise<NewSessionResponse> => {
      const { searchSessionId } = await client.createSession()
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, { haystackSessionId: searchSessionId, abortController: null })

      return {
        sessionId,
      }
    },

    prompt: async (params: PromptRequest): Promise<PromptResponse> => {
      const session = sessions.get(params.sessionId)
      if (!session) {
        throw new Error('Session not found')
      }

      const ac = new AbortController()
      session.abortController = ac

      const text = params.prompt
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')

      try {
        const sseResponse = await client.chatStream({ query: text, sessionId: session.haystackSessionId }, ac.signal)

        if (!sseResponse.body) {
          throw new Error('Haystack streaming response has no body')
        }

        let references: ReturnType<typeof extractReferences> = []
        let documents: ReturnType<typeof extractDocuments> = []

        for await (const event of parseSSE(sseResponse.body)) {
          if (ac.signal.aborted) {
            break
          }

          if (event.type === 'delta') {
            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: event.delta },
              },
            })
          }

          if (event.type === 'result') {
            references = extractReferences(event.result)
            documents = extractDocuments(event.result)

            // Send references immediately via _meta so frontend can render citations during streaming
            if (references.length > 0) {
              await conn.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: '' },
                  _meta: { haystackReferences: references },
                },
              })
            }
          }

          if (event.type === 'error') {
            throw new Error(event.error)
          }
        }

        session.abortController = null

        if (ac.signal.aborted) {
          return { stopReason: 'cancelled' }
        }

        return {
          stopReason: 'end_turn',
          _meta: {
            haystackDocuments: documents,
            haystackReferences: references,
          },
        }
      } catch (error) {
        session.abortController = null

        if (ac.signal.aborted) {
          return { stopReason: 'cancelled' }
        }

        throw error
      }
    },

    cancel: async (params: CancelNotification): Promise<void> => {
      const session = sessions.get(params.sessionId)
      session?.abortController?.abort()
    },
  })

  return agent
}
