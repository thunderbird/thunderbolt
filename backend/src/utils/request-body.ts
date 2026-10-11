/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  if (Number(request.headers.get('content-length')) > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  // Breaking out of `for await` cancels the stream, so the rest of an oversized body is never read.
  for await (const chunk of request.body) {
    total += chunk.byteLength
    if (total > maxBytes) {
      return { ok: false, reason: 'too_large' }
    }
    chunks.push(chunk)
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
