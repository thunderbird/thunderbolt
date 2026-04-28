import { z } from 'zod'
import type {
  DeepsetResultPayload,
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

/** Deepset returns 591 when a pipeline is waking from idle. */
const pipelineNotReadyStatus = 591
const maxRetryAttempts = 3

export type HaystackOutputType = 'CHAT' | 'DOCUMENT'

export class HaystackClient {
  private config: HaystackConfig
  private fetchFn: typeof fetch
  private cachedOutputType: HaystackOutputType | null = null
  private retryBaseDelayMs: number

  constructor(config: HaystackConfig, fetchFn: typeof fetch = globalThis.fetch, retryBaseDelayMs = 3000) {
    this.config = config
    this.fetchFn = fetchFn
    this.retryBaseDelayMs = retryBaseDelayMs
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

  /** Retry a fetch on 591 (pipeline waking from idle) with backoff. */
  private async fetchWithPipelineRetry(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < maxRetryAttempts; attempt++) {
      const response = await this.fetchFn(url, init)
      if (response.ok) {
        return response
      }

      if (response.status === pipelineNotReadyStatus && attempt < maxRetryAttempts - 1) {
        await this.abortableSleep(this.retryBaseDelayMs * (attempt + 1), init.signal)
        continue
      }

      const body = await response.text().catch(() => '')
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`)
    }

    throw new Error('Haystack API: retries exhausted')
  }

  private abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    if (ms <= 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal!.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Auto-detect pipeline output type from the Haystack API. Cached after first call. */
  async getOutputType(): Promise<HaystackOutputType> {
    if (this.cachedOutputType) {
      return this.cachedOutputType
    }

    try {
      const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}`
      const response = await this.fetchFn(url, { method: 'GET', headers: this.headers })
      if (response.ok) {
        const data = (await response.json()) as { output_type?: string }
        this.cachedOutputType = data.output_type === 'DOCUMENT' ? 'DOCUMENT' : 'CHAT'
      }
    } catch {
      // Fall back to CHAT if the metadata endpoint is unavailable
    }

    this.cachedOutputType ??= 'CHAT'
    return this.cachedOutputType
  }

  async createSession(): Promise<HaystackSessionResponse> {
    const url = `${this.baseApiUrl}/search_sessions`
    const body = JSON.stringify({ pipeline_id: this.config.pipelineId })
    const response = await this.fetchWithPipelineRetry(url, { method: 'POST', headers: this.headers, body })

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
      const body = await response.text().catch(() => '')
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`)
    }

    const data = await response.json()
    return this.parseChatResponse(data)
  }

  async chatStream(request: HaystackChatStreamRequest, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}/chat-stream`
    const body = JSON.stringify({
      query: request.query,
      search_session_id: request.sessionId,
      include_result: true,
    })
    const headers = { ...this.headers, Accept: 'text/event-stream' }

    return this.fetchWithPipelineRetry(url, { method: 'POST', headers, body, signal })
  }

  async search(query: string, signal?: AbortSignal): Promise<DeepsetResultPayload> {
    const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}/search`
    const response = await this.fetchWithPipelineRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ queries: [query] }),
      signal,
    })

    const data = (await response.json()) as { results?: [DeepsetResultPayload] }
    return data.results?.[0] ?? { answers: [], documents: [] }
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
      const body = await response.text().catch(() => '')
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`)
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
