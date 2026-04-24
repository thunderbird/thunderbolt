import { z } from 'zod'
import { deepsetResultPayloadSchema } from './types'
import type { DeepsetResultPayload, HaystackChatStreamRequest, HaystackConfig, HaystackSessionResponse } from './types'

const rawSessionSchema = z.object({
  search_session_id: z.string(),
})

const outputTypeSchema = z.object({ output_type: z.string().optional() })

const rawSearchResponseSchema = z.object({ results: z.array(deepsetResultPayloadSchema).optional() })

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
        void response.body?.cancel()
        await this.abortableSleep(this.retryBaseDelayMs * (attempt + 1), init.signal)
        continue
      }

      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
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

  /** Auto-detect pipeline output type from the Haystack API. Cached after first successful call. */
  async getOutputType(): Promise<HaystackOutputType> {
    if (this.cachedOutputType) {
      return this.cachedOutputType
    }

    try {
      const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}`
      const response = await this.fetchWithPipelineRetry(url, { method: 'GET', headers: this.headers })
      const parsed = outputTypeSchema.safeParse(await response.json())
      if (!parsed.success) {
        console.warn('[HaystackClient] getOutputType: unexpected response shape, defaulting to CHAT')
      } else {
        this.cachedOutputType = parsed.data.output_type === 'DOCUMENT' ? 'DOCUMENT' : 'CHAT'
        return this.cachedOutputType
      }
    } catch {
      // Fall back to CHAT if the metadata endpoint is unavailable
    }

    return 'CHAT'
  }

  async createSession(): Promise<HaystackSessionResponse> {
    const url = `${this.baseApiUrl}/search_sessions`
    const body = JSON.stringify({ pipeline_id: this.config.pipelineId })
    const response = await this.fetchWithPipelineRetry(url, { method: 'POST', headers: this.headers, body })

    const data = await response.json()
    const parsed = rawSessionSchema.parse(data)
    return { searchSessionId: parsed.search_session_id }
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

    const parsed = rawSearchResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      console.warn('[HaystackClient] search: unexpected response shape, returning empty result')
      return { answers: [], documents: [] }
    }
    return parsed.data.results?.[0] ?? { answers: [], documents: [] }
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
}
