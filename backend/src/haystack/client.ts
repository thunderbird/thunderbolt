import { z } from 'zod'
import type {
  HaystackChatRequest,
  HaystackChatResponse,
  HaystackChatStreamRequest,
  HaystackConfig,
  HaystackSessionResponse,
} from './types'

const rawSessionSchema = z.object({
  search_session_id: z.string(),
})

const rawReferenceSchema = z.object({
  label: z.string(),
  document_id: z.string(),
  document_position: z.number(),
  score: z.number(),
})

const rawFileSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const rawAnswerSchema = z.object({
  answer: z.string(),
  type: z.literal('generative'),
  document_ids: z.array(z.string()),
  files: z.array(rawFileSchema).default([]),
  meta: z.object({ _references: z.array(rawReferenceSchema).default([]) }).default({ _references: [] }),
})

const rawDocumentSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
  file: rawFileSchema,
  meta: z.record(z.unknown()).default({}),
})

const rawChatResponseSchema = z.object({
  query_id: z.string(),
  results: z.array(
    z.object({
      query_id: z.string(),
      query: z.string(),
      answers: z.array(rawAnswerSchema),
      documents: z.array(rawDocumentSchema),
    }),
  ),
})

export class HaystackClient {
  private config: HaystackConfig
  private fetchFn: typeof fetch

  constructor(config: HaystackConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.config = config
    this.fetchFn = fetchFn
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private get baseApiUrl() {
    return `${this.config.baseUrl}/api/v1/workspaces/${this.config.workspaceName}`
  }

  async createSession(): Promise<HaystackSessionResponse> {
    const response = await this.fetchFn(`${this.baseApiUrl}/search_sessions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ pipeline_id: this.config.pipelineId }),
    })

    if (!response.ok) {
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const parsed = rawSessionSchema.parse(data)
    return { searchSessionId: parsed.search_session_id }
  }

  async chat(request: HaystackChatRequest): Promise<HaystackChatResponse> {
    const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}/chat`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        queries: [request.query],
        search_session_id: request.sessionId,
        chat_history_limit: request.chatHistoryLimit ?? 3,
      }),
    })

    if (!response.ok) {
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return this.parseChatResponse(data)
  }

  async chatStream(request: HaystackChatStreamRequest, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}/chat-stream`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { ...this.headers, Accept: 'text/event-stream' },
      body: JSON.stringify({
        query: request.query,
        search_session_id: request.sessionId,
        include_result: true,
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
    }

    return response
  }

  async downloadFile(fileId: string): Promise<Response> {
    if (!/^[\w-]+$/.test(fileId)) {
      throw new Error('Invalid file ID')
    }
    const url = `${this.baseApiUrl}/files/${fileId}`
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: '*/*',
      },
    })

    if (!response.ok) {
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
    }

    return response
  }

  private parseChatResponse(raw: unknown): HaystackChatResponse {
    const parsed = rawChatResponseSchema.parse(raw)
    return {
      queryId: parsed.query_id,
      results: parsed.results.map((r) => ({
        queryId: r.query_id,
        query: r.query,
        answers: r.answers.map((a) => ({
          answer: a.answer,
          type: a.type,
          documentIds: a.document_ids,
          files: a.files,
          meta: {
            _references: a.meta._references.map((ref) => ({
              label: ref.label,
              documentId: ref.document_id,
              documentPosition: ref.document_position,
              score: ref.score,
            })),
          },
        })),
        documents: r.documents.map((d) => ({
          id: d.id,
          content: d.content,
          score: d.score,
          file: d.file,
          meta: d.meta,
        })),
      })),
    }
  }
}
