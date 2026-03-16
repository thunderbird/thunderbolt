import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { fetch } from '@/lib/fetch'
import type { HaystackDocumentMeta, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
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
  }>
  documents: Array<{
    id: string
    content: string
    score: number
    file: { id: string; name: string }
  }>
}

/**
 * Parse SSE events from a ReadableStream.
 * Handles `data: ` prefix lines separated by double newlines.
 * @internal Exported for testing only
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<DeepsetSSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) continue

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
 * Format document widgets from Deepset result.
 * Excludes low-relevance results (<1% score).
 * @internal Exported for testing only
 */
export const formatDocumentWidgets = (
  result: DeepsetResultPayload,
): { widgets: string; documentsMeta: HaystackDocumentMeta[] } => {
  const answer = result?.answers[0]
  const docsByFileId = new Map<string, DeepsetResultPayload['documents'][0]>()
  for (const d of result.documents) {
    if (!docsByFileId.has(d.file.id)) docsByFileId.set(d.file.id, d)
  }

  const widgetTags = (answer?.files ?? [])
    .flatMap((file) => {
      const doc = docsByFileId.get(file.id)
      if (!doc || doc.score < 0.01) return []
      const snippet = doc.content ? doc.content.slice(0, 200).replace(/"/g, '&quot;') : ''
      const score = doc.score.toFixed(4)
      return [
        `<widget:document-result name="${file.name}" fileId="${file.id}" snippet="${snippet}" score="${score}" />`,
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
      let documents: HaystackDocumentMeta[] = []

      // Write start immediately (before any await) so the SDK creates the
      // assistant message and shows the loading spinner during async setup.
      writer.write({ type: 'start', messageMetadata: { modelId } })

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

      for await (const event of parseSSE(sseResponse.body)) {
        if (event.type === 'delta') {
          writer.write({ type: 'text-delta', id: textPartId, delta: event.delta })
        }
        if (event.type === 'result') {
          const { widgets, documentsMeta } = formatDocumentWidgets(event.result)
          if (widgets) {
            writer.write({ type: 'text-delta', id: textPartId, delta: '\n\n' + widgets })
          }
          documents = documentsMeta
        }
        if (event.type === 'error') {
          writer.write({ type: 'error', errorText: event.error })
        }
      }

      writer.write({ type: 'text-end', id: textPartId })
      writer.write({
        type: 'finish',
        finishReason: 'stop',
        messageMetadata: { modelId, haystackDocuments: documents },
      })
    },
  })

  return createUIMessageStreamResponse({ stream })
}
