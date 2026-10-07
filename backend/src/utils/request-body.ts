/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read a request body as text without ever holding more than `limit` bytes. Returns null when the body is
 * over the limit: up front from `Content-Length` when declared, otherwise as soon as the streamed bytes cross
 * it, which covers chunked bodies.
 */
export const readBodyWithinLimit = async (request: Request, limit: number): Promise<string | null> => {
  if (!request.body) {
    return ''
  }
  if (Number(request.headers.get('content-length')) > limit) {
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  // Breaking out of `for await` cancels the stream, so the rest of an oversized body is never read.
  for await (const chunk of request.body) {
    total += chunk.byteLength
    if (total > limit) {
      return null
    }
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
