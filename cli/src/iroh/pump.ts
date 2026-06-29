/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Byte pumps between a process's stdio and an iroh bidirectional QUIC stream.
 *
 * Unlike the WebSocket bridge, an iroh bidi stream is a raw byte pipe with no
 * frame boundaries — but ACP/MCP stdio is newline-delimited JSON, which is
 * self-delimiting, so each direction is a verbatim byte copy. The ndjson
 * newlines that the WebSocket path has to re-insert/re-split are carried
 * through untouched here, keeping both halves symmetric and framing-agnostic.
 */

import type { RecvStream, SendStream } from '@number0/iroh'

/** Max bytes pulled per `recv.read`; a comfortably large ceiling for JSON-RPC. */
const READ_CHUNK_LIMIT = 1 << 16

/**
 * Copy a readable byte source (e.g. a subprocess `stdout` or `Bun.stdin`) into
 * an iroh send stream, finishing the stream when the source ends.
 *
 * @param source - the readable side to drain
 * @param send - the iroh send half to write into
 */
export const forwardToSend = async (source: ReadableStream<Uint8Array>, send: SendStream): Promise<void> => {
  const reader = source.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value && value.length > 0) await send.writeAll(Array.from(value))
    }
  } finally {
    // Finish the send half on both the clean-EOF and error paths so the peer
    // always observes the stream end (and never blocks on its read side).
    reader.releaseLock()
    await send.finish()
  }
}

/**
 * Copy an iroh recv stream into a byte sink (e.g. a subprocess `stdin` or this
 * process's `stdout`), returning when the remote finishes the stream (a zero-
 * length read signals EOF).
 *
 * @param recv - the iroh recv half to drain
 * @param sink - called with each received chunk
 */
export const forwardFromRecv = async (recv: RecvStream, sink: (chunk: Uint8Array) => void): Promise<void> => {
  while (true) {
    const chunk = await recv.read(READ_CHUNK_LIMIT)
    if (chunk.length === 0) break
    sink(Uint8Array.from(chunk))
  }
}
