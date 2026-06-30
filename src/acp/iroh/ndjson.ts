/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Newline-delimited JSON framing for the iroh byte pipe.
 *
 * An iroh bidi stream is a raw byte pipe with no message boundaries, so the ACP
 * JSON-RPC objects are framed exactly as the CLI bridge frames them
 * (`cli/src/iroh/pump.ts`): one JSON value per line, `\n`-terminated. The
 * WebSocket transport gets discrete frames for free; here we add/strip the
 * newline and re-assemble lines split across QUIC reads.
 */

/**
 * Hard ceiling on a single ndjson frame — whether it is still buffering across
 * chunks (no newline yet) or arrived already newline-terminated. A bridge that
 * streams bytes without a newline would grow the pending buffer unbounded, and a
 * single oversized terminated frame would hand `JSON.parse` a huge allocation;
 * either OOMs the tab. Past this size we fail loud instead. Measured in UTF-16
 * code units (`string.length`) — for the ASCII JSON-RPC traffic this frames that
 * tracks bytes closely, and for multi-byte content it still bounds memory within
 * a small constant factor.
 */
const maxFrameLength = 16 * 1024 * 1024

/** Encode a JSON-RPC message as a single `\n`-terminated UTF-8 frame. */
export const encodeNdjsonFrame = (message: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(message)}\n`)

/** A stateful decoder that re-assembles complete JSON values from byte chunks,
 *  buffering a partial trailing line until its newline arrives. */
export type NdjsonDecoder = {
  /** Feed a received byte chunk; returns every complete message it completes. */
  push: (chunk: Uint8Array) => unknown[]
}

/**
 * Create an {@link NdjsonDecoder}. A streaming `TextDecoder` handles multi-byte
 * UTF-8 sequences split across chunk boundaries; line buffering handles JSON
 * values split across chunks. Blank lines are skipped.
 */
export const createNdjsonDecoder = (): NdjsonDecoder => {
  const textDecoder = new TextDecoder()
  let buffer = ''
  return {
    push: (chunk) => {
      buffer += textDecoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      // The final element is the (possibly empty) incomplete trailing line.
      buffer = lines.pop() ?? ''
      // No single frame may exceed the cap — neither the still-pending trailing
      // line (which grows across newline-less chunks) nor an already-completed
      // line (a lone oversized terminated frame would still hit `JSON.parse`).
      if (buffer.length > maxFrameLength || lines.some((line) => line.length > maxFrameLength)) {
        // Reset so a caught error can't be retried into the same overflow, then
        // fail loud — a frame this large is a broken/abusive peer, not a value
        // we should keep buffering or parse toward an OOM.
        buffer = ''
        throw new Error(`ndjson frame exceeded ${maxFrameLength} chars`)
      }
      return lines.filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown)
    },
  }
}
