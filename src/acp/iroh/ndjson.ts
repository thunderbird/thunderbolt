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
      return lines.filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown)
    },
  }
}
