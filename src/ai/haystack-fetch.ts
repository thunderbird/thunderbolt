import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { fetch } from '@/lib/fetch'
import type { HaystackDocumentMeta, HaystackReferenceMeta, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { v7 as uuidv7 } from 'uuid'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'

type HaystackFetchOptions = {
  init: RequestInit
  saveMessages: SaveMessagesFunction
  modelId: string
  getOrCreateHaystackSessionId: () => Promise<string>
}

export type DeepsetSSEEvent =
  | { type: 'delta'; delta: string }
  | { type: 'result'; result: DeepsetResultPayload }
  | { type: 'error'; error: string }
  | { type: 'end' }

/**
 * Shape of a single result from the Deepset chat-stream SSE.
 * The streaming endpoint returns the result directly (answers + documents),
 * unlike the non-streaming endpoint which wraps them in a `results` array.
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

/**
 * Parse SSE events from a ReadableStream.
 * Handles `data: ` prefix lines separated by double newlines.
 * @internal Exported for testing only
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
 * @internal Exported for testing only
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
 * Format document widgets from Deepset result.
 * When references are provided, only shows widgets for files actually cited.
 * Excludes low-relevance results (<1% score).
 * @internal Exported for testing only
 */
export const formatDocumentWidgets = (
  result: DeepsetResultPayload,
  references?: HaystackReferenceMeta[],
): { widgets: string; documentsMeta: HaystackDocumentMeta[] } => {
  const answer = result?.answers[0]
  const docsByFileId = new Map<string, DeepsetResultPayload['documents'][0]>()
  for (const d of result.documents) {
    if (!docsByFileId.has(d.file.id) || d.score > docsByFileId.get(d.file.id)!.score) {
      docsByFileId.set(d.file.id, d)
    }
  }

  const citedFileIds = references && references.length > 0 ? new Set(references.map((r) => r.fileId)) : null

  const widgetTags = (answer?.files ?? [])
    .flatMap((file) => {
      if (citedFileIds && !citedFileIds.has(file.id)) {
        return []
      }
      const doc = docsByFileId.get(file.id)
      if (!doc || doc.score < 0.01) {
        return []
      }
      const escAttr = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;')
          .replace(/\//g, '&#x2F;')
      const snippet = doc.content ? escAttr(doc.content.slice(0, 200)) : ''
      const score = doc.score.toFixed(4)
      return [
        `<widget:document-result name="${escAttr(file.name)}" fileId="${escAttr(file.id)}" snippet="${snippet}" score="${score}" />`,
      ]
    })
    .join('\n')

  const documentsMeta: HaystackDocumentMeta[] = result.documents.map((d) => ({
    id: d.id,
    content: d.content,
    score: d.score,
    file: d.file,
  }))

  return { widgets: widgetTags, documentsMeta }
}

type StreamWriter = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  write: (data: any) => void
}

/**
 * Processes parsed SSE events, writing deltas and metadata to the stream writer.
 * Emits `message-metadata` with `haystackReferences` immediately when the result
 * event arrives, so the UI can render inline citations during streaming — not just
 * after the stream finishes.
 * @internal Exported for testing only
 */
export const processSSEEvents = async (
  events: AsyncGenerator<DeepsetSSEEvent>,
  writer: StreamWriter,
  textPartId: string,
): Promise<{ references: HaystackReferenceMeta[]; documents: HaystackDocumentMeta[] }> => {
  let documents: HaystackDocumentMeta[] = []
  let references: HaystackReferenceMeta[] = []

  for await (const event of events) {
    if (event.type === 'delta') {
      writer.write({ type: 'text-delta', id: textPartId, delta: event.delta })
    }
    if (event.type === 'result') {
      references = extractReferences(event.result)

      // Push references to client immediately so citations render during streaming
      if (references.length > 0) {
        writer.write({ type: 'message-metadata', messageMetadata: { haystackReferences: references } })
      }

      const { widgets, documentsMeta } = formatDocumentWidgets(event.result, references)
      if (widgets) {
        writer.write({ type: 'text-delta', id: textPartId, delta: '\n\n' + widgets })
      }
      documents = documentsMeta
    }
    if (event.type === 'error') {
      writer.write({ type: 'error', errorText: event.error })
    }
  }

  return { references, documents }
}

/**
 * Streaming fetch handler for Haystack document search.
 * Consumes Deepset SSE and produces a Vercel AI SDK UIMessageStream,
 * so document-search flows through the same pipeline as normal AI chat.
 *
 * All async work (saveMessages, session creation, API call) happens inside the
 * `execute` callback so the Response is returned immediately — this lets the SDK
 * transition to `streaming` status and show the loading spinner while we wait
 * for the first delta from Deepset.
 */
export const haystackFetchStreamingResponse = async ({
  init,
  saveMessages,
  modelId,
  getOrCreateHaystackSessionId,
}: HaystackFetchOptions): Promise<Response> => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const { messages, id } = body as { messages: ThunderboltUIMessage[]; id: string }

  let lastUserMessage: ThunderboltUIMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessage = messages[i]
      break
    }
  }
  const query =
    lastUserMessage?.parts
      ?.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim() ?? ''

  if (!query) {
    throw new Error('Document Search requires a text message')
  }

  const stream = createUIMessageStream({
    generateId: uuidv7,
    execute: async ({ writer }) => {
      const textPartId = uuidv7()

      // Write start immediately (before any await) so the SDK creates the
      // assistant message and shows the loading spinner during async setup.
      writer.write({ type: 'start', messageMetadata: { modelId, isDocumentSearch: true } })

      const db = getDb()
      const [, sessionId, { cloudUrl }] = await Promise.all([
        saveMessages({ id, messages }),
        getOrCreateHaystackSessionId(),
        getSettings(db, { cloud_url: 'http://localhost:8000/v1' }),
      ])

      const sseResponse = await fetch(`${cloudUrl}/haystack/chat-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, sessionId }),
      })

      if (!sseResponse.ok) {
        throw new Error(`Haystack streaming error: ${sseResponse.status} ${sseResponse.statusText}`)
      }

      if (!sseResponse.body) {
        throw new Error('Haystack streaming response has no body')
      }

      writer.write({ type: 'text-start', id: textPartId })

      const { references, documents } = await processSSEEvents(parseSSE(sseResponse.body), writer, textPartId)

      writer.write({ type: 'text-end', id: textPartId })
      writer.write({
        type: 'finish',
        finishReason: 'stop',
        messageMetadata: {
          modelId,
          haystackDocuments: documents,
          ...(references.length > 0 && { haystackReferences: references }),
        },
      })
    },
  })

  return createUIMessageStreamResponse({ stream })
}
