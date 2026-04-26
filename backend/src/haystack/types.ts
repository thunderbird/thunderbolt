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

export type HaystackChatStreamRequest = {
  query: string
  sessionId: string
}

export type HaystackSessionResponse = {
  searchSessionId: string
}

import { z } from 'zod'

export type {
  DocumentMeta as HaystackDocumentMeta,
  DocumentFile as HaystackFile,
  DocumentReference as HaystackReferenceMeta,
} from '../../../shared/document-types'

const deepsetFileSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const deepsetReferenceSchema = z.object({
  document_position: z.number(),
  document_id: z.string(),
})

const deepsetAnswerSchema = z.object({
  answer: z.string(),
  files: z.array(deepsetFileSchema).default([]),
  meta: z
    .object({
      _references: z.array(deepsetReferenceSchema).default([]),
    })
    .optional(),
})

const deepsetDocumentSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
  file: deepsetFileSchema,
  meta: z.object({ page_number: z.number().optional() }).optional(),
})

export const deepsetResultPayloadSchema = z.object({
  answers: z.array(deepsetAnswerSchema),
  documents: z.array(deepsetDocumentSchema),
})

/**
 * Shape of a single result from the Deepset chat-stream SSE.
 * Derived from deepsetResultPayloadSchema.
 */
export type DeepsetResultPayload = z.infer<typeof deepsetResultPayloadSchema>

export type DeepsetSSEEvent =
  | { type: 'delta'; delta: string }
  | { type: 'result'; result: DeepsetResultPayload }
  | { type: 'error'; error: string }
  | { type: 'end' }
