/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JsonRpcMessage, LineHandler, NdjsonReader } from './types'

/** Thrown when a frame fails to parse as JSON so the face can drop + log it. */
class MalformedFrameError extends Error {
  constructor() {
    super('malformed frame')
    this.name = 'MalformedFrameError'
  }
}

/**
 * Incremental NDJSON line splitter over a byte stream. Buffers partial chunks,
 * emits one `onLine` per complete `\n`-terminated line (sans the newline),
 * tolerates `\r\n`, skips empty/whitespace-only lines, and never emits a
 * partial line. `flush()` emits a trailing unterminated line if present.
 */
const createNdjsonReader = (onLine: LineHandler): NdjsonReader => {
  let buffer = ''

  const emit = (raw: string): void => {
    const line = raw.replace(/\r$/, '').trim()
    if (line.length > 0) onLine(line)
  }

  return {
    push(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        emit(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    },
    flush(): void {
      if (buffer.length === 0) return
      emit(buffer)
      buffer = ''
    },
  }
}

/**
 * Parse a frame string as JSON, throwing a typed MalformedFrameError on bad
 * input so callers can drop the frame and log only its method/id classification.
 */
const parseFrame = (text: string): JsonRpcMessage => {
  try {
    return JSON.parse(text) as JsonRpcMessage
  } catch {
    throw new MalformedFrameError()
  }
}

/**
 * Map one NDJSON child-stdout line to the WS message payload the app expects: a
 * single JSON-RPC object per WS message, no trailing newline. Validates it
 * parses as JSON; throws MalformedFrameError otherwise.
 */
const frameToWs = (line: string): string => {
  parseFrame(line)
  return line
}

/**
 * Map one inbound WS message (one JSON-RPC object) to the NDJSON line written to
 * child stdin — appends exactly one `\n`. Validates JSON; throws
 * MalformedFrameError otherwise.
 */
const wsToFrame = (message: string): string => {
  parseFrame(message)
  return `${message}\n`
}

export { MalformedFrameError, createNdjsonReader, frameToWs, wsToFrame, parseFrame }
