/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  deepsetResultPayloadSchema,
  type DeepsetResultPayload,
  type HaystackDocumentMeta,
  type HaystackEvent,
  type HaystackReferenceMeta,
} from './types'

/**
 * Error thrown when an SSE chunk cannot be parsed or fails schema validation.
 * Carries a 1-based line number so callers can pinpoint the bad frame in
 * upstream logs without having to re-assemble the raw stream.
 */
export class HaystackSseParseError extends Error {
  readonly lineNumber: number
  readonly raw: string
  constructor(message: string, lineNumber: number, raw: string) {
    super(`${message} (line ${lineNumber}): ${raw}`)
    this.name = 'HaystackSseParseError'
    this.lineNumber = lineNumber
    this.raw = raw
  }
}

/**
 * Translate a parsed Deepset SSE JSON object into our normalized
 * {@link HaystackEvent}. Returns `null` for envelope shapes we don't care
 * about (e.g. `delta` with no `text`, unknown types) — the parser drops them
 * silently so a forward-compatible upstream extension can't break the stream.
 *
 * The Deepset envelopes we observe in production:
 *  - `{ type: "delta", delta: { text: string } }`
 *  - `{ type: "result", result: { answers, documents } }`
 *  - `{ type: "error", message: string }`
 *
 * Any malformed `result` payload throws — that's a real upstream contract
 * break worth surfacing loudly.
 */
const translateDeepsetEnvelope = (
  raw: Record<string, unknown>,
  lineNumber: number,
  rawText: string,
): HaystackEvent | null => {
  const type = raw.type
  if (type === 'delta') {
    const delta = raw.delta as Record<string, unknown> | undefined
    if (delta && typeof delta.text === 'string') {
      return { type: 'delta', text: delta.text }
    }
    return null
  }
  if (type === 'result') {
    const parsed = deepsetResultPayloadSchema.safeParse(raw.result)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      throw new HaystackSseParseError(`result schema mismatch — ${issues}`, lineNumber, rawText)
    }
    return { type: 'result', result: parsed.data }
  }
  if (type === 'error') {
    const message = typeof raw.message === 'string' ? raw.message : 'unknown upstream error'
    return { type: 'error', error: message }
  }
  // Forward-compatible: ignore envelope shapes we don't recognize.
  return null
}

/**
 * Streaming SSE parser for Deepset Cloud's `/chat-stream` endpoint.
 *
 * Contract: standard `data: <json>\n\n` framing. Comments (`:` prefix),
 * keep-alives (blank lines), and `event:`/`id:`/`retry:` fields are accepted
 * but only `data:` lines yield events. The sentinel `data: [DONE]` line
 * terminates the stream and yields a `done` event.
 *
 * Why streaming: chat-stream responses can be multi-MB. Buffering would let
 * upstream stalls bubble straight through to the websocket client.
 *
 * Why no defensive try/catch around the schema: a malformed `result` payload
 * is a real upstream contract break — we want it surfaced loudly so the FE
 * sees the failure instead of receiving a silently-truncated answer.
 */
export const parseHaystackSseStream = async function* (
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterableIterator<HaystackEvent> {
  // Per-invocation: a streaming TextDecoder retains partial multi-byte state between
  // decode() calls, so a shared instance would corrupt bytes across concurrent streams.
  const decoder = new TextDecoder()
  let buffer = ''
  let lineNumber = 0

  const flushFrame = (frame: string): HaystackEvent | null => {
    let dataPayload: string | null = null
    for (const rawLine of frame.split('\n')) {
      lineNumber += 1
      const line = rawLine.replace(/\r$/, '')
      if (line === '' || line.startsWith(':')) {
        continue
      }
      if (line.startsWith('data:')) {
        const payload = line.slice(5).replace(/^ /, '')
        dataPayload = dataPayload === null ? payload : `${dataPayload}\n${payload}`
        continue
      }
      // `event:`, `id:`, `retry:` — valid SSE but unused upstream.
    }

    if (dataPayload === null) {
      return null
    }
    if (dataPayload === '[DONE]') {
      return { type: 'done' }
    }

    let json: unknown
    try {
      json = JSON.parse(dataPayload)
    } catch (err) {
      throw new HaystackSseParseError(
        `malformed JSON in data payload: ${(err as Error).message}`,
        lineNumber,
        dataPayload,
      )
    }

    if (typeof json !== 'object' || json === null) {
      throw new HaystackSseParseError('data payload is not a JSON object', lineNumber, dataPayload)
    }

    return translateDeepsetEnvelope(json as Record<string, unknown>, lineNumber, dataPayload)
  }

  const drainBuffer = function* (): IterableIterator<HaystackEvent> {
    let separatorIndex = buffer.indexOf('\n\n')
    while (separatorIndex !== -1) {
      const frame = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      const event = flushFrame(frame)
      if (event !== null) {
        yield event
      }
      separatorIndex = buffer.indexOf('\n\n')
    }
  }

  const iterator: AsyncIterator<Uint8Array> =
    'getReader' in source ? readableStreamIterator(source) : source[Symbol.asyncIterator]()

  while (true) {
    const next = await iterator.next()
    if (next.done) {
      break
    }
    buffer += decoder.decode(next.value, { stream: true })
    yield* drainBuffer()
  }

  buffer += decoder.decode()
  if (buffer.length > 0 && !buffer.endsWith('\n\n')) {
    const event = flushFrame(buffer)
    if (event !== null) {
      yield event
    }
    buffer = ''
  } else {
    yield* drainBuffer()
  }
}

/** Adapt a Web `ReadableStream` to an `AsyncIterator`. */
const readableStreamIterator = (stream: ReadableStream<Uint8Array>): AsyncIterator<Uint8Array> => {
  const reader = stream.getReader()
  return {
    next: async () => {
      const result = await reader.read()
      if (result.done) {
        return { done: true, value: undefined }
      }
      return { done: false, value: result.value }
    },
    return: async () => {
      reader.releaseLock()
      return { done: true, value: undefined }
    },
  }
}

/**
 * Extract citation references from a Deepset `result` payload. Joins the
 * `_references` array against the result's `documents` to resolve file
 * metadata and page numbers.
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

/** Extract document metadata from a Deepset `result` payload. */
export const extractDocuments = (result: DeepsetResultPayload): HaystackDocumentMeta[] =>
  result.documents.map((d) => ({
    id: d.id,
    content: d.content,
    score: d.score,
    file: d.file,
  }))
