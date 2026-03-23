export type HaystackConfig = {
  apiKey: string
  baseUrl: string
  workspaceName: string
  pipelineName: string
  pipelineId: string
}

export type HaystackPipelineConfig = {
  slug: string
  name: string
  pipelineName: string
  pipelineId: string
  icon?: string
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

export type HaystackDocumentMeta = {
  id: string
  content: string
  score: number
  file: HaystackFile
}

export type HaystackReferenceMeta = {
  position: number
  fileId: string
  fileName: string
  pageNumber?: number
}

/**
 * Shape of a single result from the Deepset chat-stream SSE.
 */
export type DeepsetResultPayload = {
  answers: Array<{
    answer: string
    files: Array<{ id: string; name: string }>
    meta?: {
      _references?: Array<{
        document_position: number
        document_id: string
      }>
    }
  }>
  documents: Array<{
    id: string
    content: string
    score: number
    file: { id: string; name: string }
    meta?: { page_number?: number }
  }>
}

export type DeepsetSSEEvent =
  | { type: 'delta'; delta: string }
  | { type: 'result'; result: DeepsetResultPayload }
  | { type: 'error'; error: string }
  | { type: 'end' }
