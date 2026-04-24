import { z } from 'zod'
import { deepsetResultPayloadSchema } from './types'
import type { DeepsetResultPayload, DeepsetSSEEvent, HaystackDocumentMeta, HaystackReferenceMeta } from './types'

const deltaEventSchema = z.object({
  type: z.literal('delta'),
  delta: z.object({ text: z.string() }),
})

const resultEventSchema = z.object({
  type: z.literal('result'),
  result: deepsetResultPayloadSchema,
})

const errorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string().optional(),
})

const sseEventSchema = z.union([deltaEventSchema, resultEventSchema, errorEventSchema])

const parseSsePayload = (json: string): DeepsetSSEEvent | null => {
  const raw = JSON.parse(json) as unknown
  const parsed = sseEventSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }

  const event = parsed.data
  if (event.type === 'delta') {
    return { type: 'delta', delta: event.delta.text }
  }
  if (event.type === 'result') {
    return { type: 'result', result: event.result }
  }
  return { type: 'error', error: event.message ?? 'Unknown error' }
}

/**
 * Parse SSE events from a ReadableStream.
 * Handles `data: ` prefix lines separated by double newlines.
 */
// eslint-disable-next-line func-style -- async generators cannot use arrow syntax
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<DeepsetSSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) {
          continue
        }

        const json = line.slice(6)
        if (json === '[DONE]') {
          yield { type: 'end' }
          continue
        }

        try {
          const event = parseSsePayload(json)
          if (event) {
            yield event
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Extracts citation references from a Deepset result by joining `_references`
 * to their matching documents to resolve file info and page numbers.
 */
export const extractReferences = (result: DeepsetResultPayload): HaystackReferenceMeta[] => {
  const refs = result.answers[0]?.meta?._references
  if (!refs || refs.length === 0) {
    return []
  }

  const docsById = new Map(result.documents.map((d) => [d.id, d]))

  return refs.flatMap((ref) => {
    const doc = docsById.get(ref.document_id)
    if (!doc) {
      return []
    }
    return [
      {
        position: ref.document_position,
        fileId: doc.file.id,
        fileName: doc.file.name,
        pageNumber: doc.meta?.page_number,
      },
    ]
  })
}

/**
 * Extracts document metadata from a Deepset result.
 */
export const extractDocuments = (result: DeepsetResultPayload): HaystackDocumentMeta[] =>
  result.documents.map((d) => ({
    id: d.id,
    content: d.content,
    score: d.score,
    file: d.file,
  }))
