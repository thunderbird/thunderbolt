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
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { HaystackClient } from './client'
import type { HaystackDocumentMeta, HaystackPipelineConfig, HaystackReferenceMeta } from './types'
import { parseSSE, extractReferences, extractDocuments } from './sse-parser'

type HaystackAcpAgentDeps = {
  client: HaystackClient
  pipelineConfig: HaystackPipelineConfig
  /** Injected persistent session map (for testing). Falls back to module-level map. */
  persistentSessions?: Map<string, string>
}

type SessionState = {
  haystackSessionId: string
  abortController: AbortController | null
}

/**
 * Module-level persistent map: ACP sessionId -> Haystack searchSessionId.
 * Survives individual WebSocket connection lifecycles so loadSession can
 * restore sessions across reconnects.
 */
const defaultPersistentSessions = new Map<string, string>()
const maxPersistentSessions = 1000

/**
 * Create an ACP Agent handler that wraps a Deepset/Haystack pipeline.
 * Streams chat responses via ACP session updates with _meta for citations.
 */
export const createHaystackAcpAgent = ({
  client,
  pipelineConfig,
  persistentSessions = defaultPersistentSessions,
}: HaystackAcpAgentDeps) => {
  const sessions = new Map<string, SessionState>()

  /** Abort all in-flight prompts and clear session state. Call on disconnect. */
  const dispose = () => {
    for (const session of sessions.values()) {
      session.abortController?.abort()
    }
    sessions.clear()
  }

  const agent: (conn: AgentSideConnection) => Agent = (conn) => ({
    initialize: async (_params: InitializeRequest): Promise<InitializeResponse> => ({
      agentInfo: { name: pipelineConfig.name, version: '1.0.0' },
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
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
      if (persistentSessions.size >= maxPersistentSessions) {
        const oldestKey = persistentSessions.keys().next().value
        if (oldestKey) persistentSessions.delete(oldestKey)
      }
      persistentSessions.set(sessionId, searchSessionId)

      return {
        sessionId,
      }
    },

    loadSession: async (params: LoadSessionRequest): Promise<LoadSessionResponse> => {
      const haystackSessionId = persistentSessions.get(params.sessionId)
      if (!haystackSessionId) {
        throw RequestError.resourceNotFound(params.sessionId)
      }
      sessions.set(params.sessionId, { haystackSessionId, abortController: null })
      return {}
    },

    prompt: async (params: PromptRequest): Promise<PromptResponse> => {
      const session = sessions.get(params.sessionId)
      if (!session) {
        throw new Error('Session not found')
      }

      const ac = new AbortController()
      session.abortController?.abort()
      session.abortController = ac

      const text = params.prompt
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')

      try {
        const outputType = await client.getOutputType()
        const { references, documents } =
          outputType === 'DOCUMENT'
            ? await handleDocumentSearch(conn, params.sessionId, client, text, ac)
            : await handleChatStream(conn, params.sessionId, client, session.haystackSessionId, text, ac)

        if (session.abortController === ac) {
          session.abortController = null
        }

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
        if (session.abortController === ac) {
          session.abortController = null
        }

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

  return { handler: agent, dispose }
}

type PromptResult = { references: HaystackReferenceMeta[]; documents: HaystackDocumentMeta[] }

/** Handle CHAT-type pipelines via streaming chat-stream endpoint. */
const handleChatStream = async (
  conn: AgentSideConnection,
  sessionId: string,
  client: HaystackClient,
  haystackSessionId: string,
  query: string,
  ac: AbortController,
): Promise<PromptResult> => {
  const sseResponse = await client.chatStream({ query, sessionId: haystackSessionId }, ac.signal)
  if (!sseResponse.body) {
    throw new Error('Haystack streaming response has no body')
  }

  const accumulatedReferences: HaystackReferenceMeta[] = []
  const accumulatedDocuments: HaystackDocumentMeta[] = []

  for await (const event of parseSSE(sseResponse.body)) {
    if (ac.signal.aborted) {
      break
    }

    if (event.type === 'delta') {
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.delta },
        },
      })
    }

    if (event.type === 'result') {
      const references = extractReferences(event.result)
      const documents = extractDocuments(event.result)
      accumulatedReferences.push(...references)
      accumulatedDocuments.push(...documents)

      if (references.length > 0) {
        await conn.sessionUpdate({
          sessionId,
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

  return { references: accumulatedReferences, documents: accumulatedDocuments }
}

/** Handle DOCUMENT-type pipelines via the /search endpoint. */
const handleDocumentSearch = async (
  conn: AgentSideConnection,
  sessionId: string,
  client: HaystackClient,
  query: string,
  ac: AbortController,
): Promise<PromptResult> => {
  const result = await client.search(query, ac.signal)
  const documents = extractDocuments(result)

  if (ac.signal.aborted || documents.length === 0) {
    return { references: [], documents }
  }

  const references: HaystackReferenceMeta[] = result.documents.map((d, i) => ({
    position: i + 1,
    fileId: d.file.id,
    fileName: d.file.name,
    pageNumber: d.meta?.page_number,
  }))

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: formatDocumentResults(documents) },
      _meta: { haystackReferences: references },
    },
  })

  return { references, documents }
}

/** Format document search results as markdown with [N] citation markers. */
export const formatDocumentResults = (documents: HaystackDocumentMeta[]): string => {
  const items = documents.map((doc, i) => {
    const normalized = doc.content.replace(/\s+/g, ' ').trim()
    const snippet = normalized.slice(0, 300)
    const ellipsis = normalized.length > 300 ? '...' : ''
    return `[${i + 1}] **${doc.file.name}**\n> ${snippet}${ellipsis}`
  })
  return `Found ${documents.length} relevant documents:\n\n${items.join('\n\n')}`
}
