export type HaystackConfig = {
  apiKey: string
  baseUrl: string
  workspaceName: string
  pipelineName: string
  pipelineId: string
}

export type HaystackChatRequest = {
  query: string
  sessionId: string
  chatHistoryLimit?: number
}

export type HaystackChatStreamRequest = {
  query: string
  sessionId: string
}

export type HaystackChatResponse = {
  queryId: string
  results: HaystackResult[]
}

export type HaystackResult = {
  queryId: string
  query: string
  answers: HaystackAnswer[]
  documents: HaystackDocument[]
}

export type HaystackAnswer = {
  answer: string
  type: 'generative'
  documentIds: string[]
  files: HaystackFile[]
  meta: { _references: HaystackReference[] }
}

export type HaystackFile = {
  id: string
  name: string
}

export type HaystackDocument = {
  id: string
  content: string
  score: number
  file: HaystackFile
  meta: Record<string, unknown>
}

export type HaystackReference = {
  label: string
  documentId: string
  documentPosition: number
  score: number
}

export type HaystackSessionResponse = {
  searchSessionId: string
}

export type HaystackSessionListResponse = {
  searchSessions: Array<{
    searchSessionId: string
    pipelineId: string
    searchHistory: { query: string; createdAt: string } | null
  }>
  hasMore: boolean
  total: number
}
