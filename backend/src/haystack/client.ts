import type {
  HaystackChatRequest,
  HaystackChatResponse,
  HaystackChatStreamRequest,
  HaystackConfig,
  HaystackSessionListResponse,
  HaystackSessionResponse,
} from './types'

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
    return { searchSessionId: data.search_session_id }
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
    return this.transformChatResponse(data)
  }

  async chatStream(request: HaystackChatStreamRequest): Promise<Response> {
    const url = `${this.baseApiUrl}/pipelines/${this.config.pipelineName}/chat-stream`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { ...this.headers, Accept: 'text/event-stream' },
      body: JSON.stringify({
        query: request.query,
        search_session_id: request.sessionId,
        include_result: true,
      }),
    })

    if (!response.ok) {
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
    }

    return response
  }

  async downloadFile(fileId: string): Promise<Response> {
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

  async listSessions(): Promise<HaystackSessionListResponse> {
    const response = await this.fetchFn(`${this.baseApiUrl}/search_sessions`, {
      method: 'GET',
      headers: this.headers,
    })

    if (!response.ok) {
      throw new Error(`Haystack API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return this.transformSessionListResponse(data)
  }

  private transformSessionListResponse(raw: Record<string, unknown>): HaystackSessionListResponse {
    const sessions = raw.search_sessions as Array<Record<string, unknown>>
    return {
      searchSessions: sessions.map((s) => {
        const history = s.search_history as Record<string, unknown> | null
        return {
          searchSessionId: s.search_session_id as string,
          pipelineId: s.pipeline_id as string,
          searchHistory: history ? { query: history.query as string, createdAt: history.created_at as string } : null,
        }
      }),
      hasMore: raw.has_more as boolean,
      total: raw.total as number,
    }
  }

  private transformChatResponse(raw: Record<string, unknown>): HaystackChatResponse {
    const results = raw.results as Array<Record<string, unknown>>
    return {
      queryId: raw.query_id as string,
      results: results.map((r) => {
        const answers = r.answers as Array<Record<string, unknown>>
        const documents = r.documents as Array<Record<string, unknown>>
        return {
          queryId: r.query_id as string,
          query: r.query as string,
          answers: answers.map((a) => {
            const meta = a.meta as Record<string, unknown> | undefined
            const refs = (meta?._references ?? []) as Array<Record<string, unknown>>
            return {
              answer: a.answer as string,
              type: a.type as 'generative',
              documentIds: a.document_ids as string[],
              files: (a.files ?? []) as Array<{ id: string; name: string }>,
              meta: {
                _references: refs.map((ref) => ({
                  label: ref.label as string,
                  documentId: ref.document_id as string,
                  documentPosition: ref.document_position as number,
                  score: ref.score as number,
                })),
              },
            }
          }),
          documents: documents.map((d) => ({
            id: d.id as string,
            content: d.content as string,
            score: d.score as number,
            file: d.file as { id: string; name: string },
            meta: (d.meta ?? {}) as Record<string, unknown>,
          })),
        }
      }),
    }
  }
}
