/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const maxBytes = 32_768

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string }

/** Bound streamed bytes as well as declared length before parsing untrusted JSON. */
export const readContactBody = async (request: Request): Promise<BodyResult> => {
  const tooLarge = { ok: false, status: 413, error: 'Request too large.' } as const
  const invalid = { ok: false, status: 400, error: 'Invalid JSON.' } as const
  if (Number(request.headers.get('Content-Length')) > maxBytes) return tooLarge
  if (!request.body) return invalid

  const reader = request.body.getReader()
  const bytes = new Uint8Array(maxBytes)
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > maxBytes) {
        await reader.cancel()
        return tooLarge
      }
      bytes.set(value, offset)
      offset += value.byteLength
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, offset))),
    }
  } catch {
    return invalid
  } finally {
    reader.releaseLock()
  }
}
