/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read a request or response body without ever holding more than `maxBytes`. An oversized body is refused
 * up front from `Content-Length` when declared, without touching the body, otherwise as soon as the streamed
 * bytes cross the cap, which covers chunked transfers.
 *
 * @param message - The request or response whose body to read.
 * @param maxBytes - The size limit.
 * @returns The body, empty when there is none, or null when it is larger than `maxBytes`.
 */
export const readBoundedBytes = async (
  message: Request | Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (Number(message.headers.get('content-length')) > maxBytes) {
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  // Leaving `for await` early cancels the stream, so the rest of an oversized body is never read.
  for await (const chunk of message.body ?? []) {
    total += chunk.byteLength
    if (total > maxBytes) {
      return null
    }
    chunks.push(chunk)
  }
  return new Uint8Array(Bun.concatArrayBuffers(chunks))
}

export type BoundedJsonResult = { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'invalid' }

/**
 * Read a JSON request body without ever holding more than `maxBytes`. An oversized body is refused up front
 * from `Content-Length` when declared, otherwise as soon as the streamed bytes cross the cap, which covers
 * chunked uploads. A missing body, invalid UTF-8 and malformed JSON are all `invalid`.
 */
export const readBoundedJson = async (request: Request, maxBytes: number): Promise<BoundedJsonResult> => {
  if (!request.body) {
    return { ok: false, reason: 'invalid' }
  }
  const bytes = await readBoundedBytes(request, maxBytes)
  if (!bytes) {
    return { ok: false, reason: 'too_large' }
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
