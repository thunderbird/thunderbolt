/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ImportFormatError } from '@/dal'

/**
 * Hard ceiling on the size of an import file we'll attempt to read into
 * memory. Applies to the *on-disk* size — a gzipped export at ~200 MB
 * decompresses to a few GB of JSON, which the importer wouldn't survive
 * anyway. Anything larger almost certainly isn't a Thunderbolt export, so we
 * refuse it before paying the `file.arrayBuffer()` allocation: picking the
 * wrong file on Tauri iOS would otherwise freeze or OOM the WebView.
 */
const maxImportBytes = 200 * 1024 * 1024

/** Gzip magic bytes (RFC 1952 §2.3.1 — `1f 8b`). */
const isGzip = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

/**
 * Reads a `File` (from an `<input type="file">`) and parses it as JSON.
 * Detects gzip via magic bytes and decompresses transparently — exports are
 * gzipped (`.json.gz`); a hand-decompressed `.json` from the same envelope
 * still imports cleanly. Returns `unknown` so the caller validates the shape
 * before using it.
 *
 * Throws an {@link ImportFormatError} when the file exceeds
 * {@link maxImportBytes} or when gzip decompression fails (truncated /
 * corrupted archive), and a `SyntaxError` with the original file name in
 * the message when the JSON doesn't parse — easier to surface in the UI
 * than the raw parser error.
 */
export const readJsonFile = async (file: File): Promise<unknown> => {
  if (file.size > maxImportBytes) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(0)
    const maxMb = maxImportBytes / 1024 / 1024
    throw new ImportFormatError(
      `"${file.name}" is too large (${sizeMb} MB). Maximum supported import size is ${maxMb} MB.`,
    )
  }
  const buffer = await file.arrayBuffer()
  const text = isGzip(new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength)))
    ? await gunzipToText(buffer, file.name)
    : new TextDecoder('utf-8').decode(buffer)
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown parse error'
    throw new SyntaxError(`Could not parse "${file.name}" as JSON: ${reason}`, { cause: error })
  }
}

const gunzipToText = async (buffer: ArrayBuffer, filename: string): Promise<string> => {
  try {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown decompression error'
    throw new ImportFormatError(`Could not decompress "${filename}": ${reason}`)
  }
}
