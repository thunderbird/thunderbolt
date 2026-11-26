/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the host will save when a Mini App asks, and under which name.
 *
 * Pure, so the policy can be tested without a frame. The bridge parses a
 * `ui/download-file` request with {@link prepareMiniAppDownload}, asks the user,
 * then hands the result to `downloadFile`.
 */

import type { DownloadRequest } from '@/lib/download'
import { safeFileName } from '@/lib/safe-file-name'
import { downloadFileParamsSchema } from '@shared/mini-app-protocol'

/** Largest file a Mini App may save. */
export const maxMiniAppDownloadBytes = 50 * 1024 * 1024

/**
 * Longest `uri` accepted. Checked before the name is parsed: the trimming in
 * `safeFileName` backtracks on a long run of dots, so an unbounded segment could freeze the host.
 */
const maxUriLength = 2048

/**
 * File types a Mini App may save, by extension, with the type each is saved as.
 *
 * An allowlist because the file lands in Downloads, where the extension decides
 * what opening it does. Nothing that runs: no installers or scripts, and no HTML
 * or SVG, which run script when opened from disk. No Office documents yet:
 * Windows and macOS saves carry the mark a browser download does (see
 * `download.ts`), so Office would open them in Protected View, but allowing
 * them here is a separate change.
 */
const savableTypes: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
}

export type PreparedMiniAppDownload = { ok: true; download: DownloadRequest } | { ok: false; message: string }

/**
 * The UTF-8 size of `text`, counted without building the encoded copy.
 *
 * `TextEncoder` would allocate up to three bytes per code unit only for the
 * copy to be measured and dropped, and a frame can ask for that on every
 * request. A surrogate pair is one four-byte character; a lone surrogate counts
 * three, because the encoder writes it as U+FFFD.
 */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const pairsWithNext = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    if (pairsWithNext) {
      bytes += 4
      index++
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
    }
  }
  return bytes
}

/** The URI's last path segment, decoded. MCP Apps names the file this way. */
const lastSegment = (uri: string): string => {
  const segment =
    uri
      .replace(/[?#].*$/, '')
      .split('/')
      .pop() ?? ''
  try {
    return decodeURIComponent(segment)
  } catch {
    // A stray `%` is not worth refusing the file over; the raw segment is still a name.
    return segment
  }
}

/** The extension to save under: the name's own, or one implied by the declared type. */
const resolveExtension = (extension: string, mimeType: string | undefined): string | null => {
  if (savableTypes[extension]) {
    return extension
  }
  if (extension !== '' || !mimeType) {
    return null
  }
  return Object.keys(savableTypes).find((candidate) => savableTypes[candidate] === mimeType) ?? null
}

/** Base64 to a binary string, or null when it isn't base64. */
const decodeToBinary = (blob: string): string | null => {
  try {
    return atob(blob)
  } catch {
    return null
  }
}

/**
 * Base64 to bytes, or null when it isn't base64. Preallocated, because
 * `Uint8Array.from(string, fn)` iterates and needs over a gigabyte at the size cap.
 */
const decodeBase64 = (blob: string): Uint8Array<ArrayBuffer> | null => {
  const binary = decodeToBinary(blob)
  if (binary === null) {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Turn a `ui/download-file` request into the file to save, or say why not.
 *
 * Messages use MCP Apps' wording ("Invalid content", "Policy violation") and
 * reach the app verbatim, so they name what to fix.
 */
export const prepareMiniAppDownload = (params: unknown): PreparedMiniAppDownload => {
  const parsed = downloadFileParamsSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, message: 'Invalid content: send exactly one embedded resource' }
  }
  const [{ resource }] = parsed.data.contents
  if (resource.uri.length > maxUriLength) {
    return { ok: false, message: 'Invalid content: the resource uri is too long' }
  }
  if ((resource.text === undefined) === (resource.blob === undefined)) {
    return { ok: false, message: 'Invalid content: the resource needs either text or blob' }
  }

  const { stem, extension } = safeFileName(lastSegment(resource.uri))
  const savedExtension = resolveExtension(extension, resource.mimeType)
  if (!savedExtension) {
    return {
      ok: false,
      message: `Policy violation: ${extension ? `.${extension} files are` : 'a file with no extension is'} not saved`,
    }
  }

  const maxMegabytes = maxMiniAppDownloadBytes / 1024 / 1024
  const tooLarge = { ok: false, message: `Policy violation: files over ${maxMegabytes} MB are not saved` } as const
  // Checked on the encoded length first, so an oversized blob is refused before it is decoded.
  if (resource.blob !== undefined && (resource.blob.length * 3) / 4 > maxMiniAppDownloadBytes + 2) {
    return tooLarge
  }
  // Every UTF-16 code unit encodes to at least one UTF-8 byte, so text longer than the limit in code
  // units is refused from its length alone, before the byte count below has to walk it.
  if (resource.text !== undefined && resource.text.length > maxMiniAppDownloadBytes) {
    return tooLarge
  }
  const contents = resource.text ?? decodeBase64(resource.blob ?? '')
  if (contents === null) {
    return { ok: false, message: 'Invalid content: blob is not base64' }
  }
  const size = typeof contents === 'string' ? utf8ByteLength(contents) : contents.byteLength
  if (size > maxMiniAppDownloadBytes) {
    return tooLarge
  }

  return {
    ok: true,
    download: { name: `${stem}.${savedExtension}`, contents, mimeType: savableTypes[savedExtension] },
  }
}
