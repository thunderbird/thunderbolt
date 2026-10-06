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
import { downloadFileParamsSchema } from '@shared/mini-app-protocol'

/** Largest file a Mini App may save. */
export const maxMiniAppDownloadBytes = 50 * 1024 * 1024

/**
 * Longest `uri` accepted. Checked before the name is parsed: the trimming below
 * backtracks on a long run of dots, so an unbounded segment could freeze the host.
 */
const maxUriLength = 2048

/**
 * File types a Mini App may save, by extension, with the type each is saved as.
 *
 * An allowlist because the file lands in Downloads, where the extension decides
 * what opening it does. Nothing that runs: no installers or scripts, and no HTML
 * or SVG, which run script when opened from disk. No Office documents yet either:
 * desktop saves carry no mark-of-the-web, so Office would open them outside
 * Protected View.
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
 * Characters a filesystem we save to rejects in a name, control characters, and
 * invisible format characters: a right-to-left override in the name would
 * reverse the prompt's own sentence around it.
 */
const unsafeCharacters = /[\p{Cc}\p{Cf}<>:"/\\|?*]/gu

/**
 * Names Windows refuses whatever follows the first dot: `CON.pdf` and
 * `aux.notes.pdf` cannot be created.
 */
const reservedNames = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

/** Longest stem in UTF-8 bytes. ext4 and APFS cap a whole name at 255 bytes, and CJK takes three each. */
const maxStemBytes = 200

const encoder = new TextEncoder()

/** The longest prefix of `value` within `maxStemBytes`, never splitting a character. */
const boundBytes = (value: string): string =>
  Array.from(value).reduce(
    (state, character) => {
      if (state.full) {
        return state
      }
      const size = encoder.encode(character).byteLength
      return state.bytes + size > maxStemBytes
        ? { ...state, full: true }
        : { text: state.text + character, bytes: state.bytes + size, full: false }
    },
    { text: '', bytes: 0, full: false },
  ).text

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

/**
 * A name that is safe to create in Downloads: no path, nothing a filesystem
 * rejects, not hidden, not a reserved device name, and not absurdly long.
 * Exported for its own test.
 */
export const safeFileName = (raw: string): { stem: string; extension: string } => {
  // Trailing dots and spaces go first, as Windows drops them: `report.pdf.` is `report.pdf`.
  const cleaned = raw
    .replace(unsafeCharacters, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s.]+$/, '')
  // Split before trimming the front, so `?.pdf` is an untitled PDF; a dot that
  // starts the name begins a hidden file instead, and has no extension.
  const dot = cleaned.lastIndexOf('.')
  const extension =
    dot > 0
      ? cleaned
          .slice(dot + 1)
          .trim()
          .toLowerCase()
      : ''
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).replace(/^[\s.]+|[\s.]+$/g, '')
  const bounded = boundBytes(stem).trim()
  if (bounded === '') {
    return { stem: 'download', extension }
  }
  return { stem: reservedNames.test(bounded) ? `_${bounded}` : bounded, extension }
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
  // units is refused before the encoder runs, rather than after it has built the oversized copy.
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
