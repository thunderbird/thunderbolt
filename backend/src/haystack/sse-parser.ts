/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { haystackEventSchema, type HaystackEvent } from './types'

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

const decoder = new TextDecoder()

/**
 * Streaming SSE parser tailored to Haystack `/runs`. The contract is the
 * standard `data: <json>\n\n` framing — comments (`:` prefix), keep-alives
 * (blank lines), and `event:` / `id:` fields are accepted but only `data:`
 * lines yield events. Each `data:` payload is JSON-parsed and validated
 * against {@link haystackEventSchema}.
 *
 * Why streaming: `/runs` responses can be multi-MB. Buffering the whole body
 * is wasteful and would let upstream stalls bubble straight through to the
 * websocket client. The async iterator yields events as soon as a complete
 * frame lands in the buffer.
 *
 * Why no try/catch around the schema: defensive failure on a malformed
 * upstream is a bug we want surfaced loudly. The caller can decide whether
 * to abort the session or fail open — this parser never silently drops data.
 */
export const parseHaystackSseStream = async function* (
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterableIterator<HaystackEvent> {
  let buffer = ''
  let lineNumber = 0

  const flushFrame = (frame: string): HaystackEvent | null => {
    // A frame is the block of lines between two consecutive \n\n separators.
    // Concatenate any `data:` payloads; ignore other fields.
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
      // `event:`, `id:`, `retry:` etc. are valid SSE but unused upstream.
      // Skipping them preserves forward compatibility without widening the
      // event surface.
    }

    if (dataPayload === null) {
      return null
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

    const parsed = haystackEventSchema.safeParse(json)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      throw new HaystackSseParseError(`schema mismatch — ${issues}`, lineNumber, dataPayload)
    }
    return parsed.data
  }

  const drainBuffer = function* (): IterableIterator<HaystackEvent> {
    // Frames are separated by a blank line (`\n\n`). Process as many complete
    // frames as the buffer currently holds, leaving the unterminated tail in
    // place for the next chunk.
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

  // Flush any final bytes from the decoder + handle a trailing frame that
  // wasn't separator-terminated.
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

/** Adapt a Web `ReadableStream` to an `AsyncIterator` (no `[Symbol.asyncIterator]`
 *  in Bun yet for byte streams in some paths — keep the bridge explicit). */
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
