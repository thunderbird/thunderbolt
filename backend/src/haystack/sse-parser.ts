import type { DeepsetResultPayload, DeepsetSSEEvent, HaystackDocumentMeta, HaystackReferenceMeta } from './types'

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
          const parsed = JSON.parse(json) as Record<string, unknown>

          if (parsed.type === 'delta' && parsed.delta) {
            const delta = parsed.delta as Record<string, unknown>
            if (typeof delta.text === 'string') {
              yield { type: 'delta', delta: delta.text }
            }
          } else if (parsed.type === 'result' && parsed.result) {
            yield { type: 'result', result: parsed.result as DeepsetResultPayload }
          } else if (parsed.type === 'error') {
            yield { type: 'error', error: (parsed.message as string) ?? 'Unknown error' }
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
