/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Output-truncation utilities for the browser coding tools, ported verbatim (in
 * behaviour) from Pi's `core/tools/truncate.ts`. The tool descriptions promise a
 * specific contract — "last/first N lines or KKB, whichever is hit first" — so the
 * model's priors depend on this exact framing; replicating it keeps the in-browser
 * tools indistinguishable from the CLI's for the model.
 *
 * Truncation honours two independent limits (whichever is hit first wins):
 *   - line limit ({@link DEFAULT_MAX_LINES})
 *   - byte limit ({@link DEFAULT_MAX_BYTES})
 *
 * `Buffer` is used for byte counting (UTF-8 aware); the app installs the global
 * `Buffer` polyfill (`ensureBufferPolyfill`) before any tool runs.
 */

/** Maximum lines retained before truncation kicks in. */
export const DEFAULT_MAX_LINES = 2000
/** Maximum bytes retained before truncation kicks in (50KB). */
export const DEFAULT_MAX_BYTES = 50 * 1024

/** Result of a head/tail truncation pass. */
export type TruncationResult = {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
  lastLinePartial: boolean
  firstLineExceedsLimit: boolean
  maxLines: number
  maxBytes: number
}

/** Options accepted by the truncation helpers. */
export type TruncateOptions = { maxLines?: number; maxBytes?: number }

/** Split content into lines for counting, dropping the trailing empty entry a
 *  final newline would otherwise produce. */
const splitLinesForCounting = (content: string): string[] => {
  if (content.length === 0) {
    return []
  }
  const lines = content.split('\n')
  if (content.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

/** Format a byte count as a human-readable size (B/KB/MB). */
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Truncate content from the head (keep the first N lines/bytes) — used by the
 * read tool. Never returns partial lines; if the first line alone exceeds the
 * byte limit, returns empty content with `firstLineExceedsLimit`.
 *
 * @param content - the text to truncate
 * @param options - optional line/byte limit overrides
 */
export const truncateHead = (content: string, options: TruncateOptions = {}): TruncationResult => {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf-8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    }
  }

  const firstLineBytes = Buffer.byteLength(lines[0], 'utf-8')
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    }
  }

  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0)
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    outputLinesArr.push(line)
    outputBytesCount += lineBytes
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }
  const outputContent = outputLinesArr.join('\n')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf-8'),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  }
}

/** Truncate a string to fit within a byte limit, keeping the END and respecting
 *  UTF-8 character boundaries. */
const truncateStringToBytesFromEnd = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= maxBytes) {
    return text
  }
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++
  }
  return buf.subarray(start).toString('utf-8')
}

/**
 * Truncate content from the tail (keep the last N lines/bytes) — used by the bash
 * tool, where the end (errors, final results) matters most. May return a partial
 * first line when the original's last line alone exceeds the byte limit.
 *
 * @param content - the text to truncate
 * @param options - optional line/byte limit overrides
 */
export const truncateTail = (content: string, options: TruncateOptions = {}): TruncationResult => {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf-8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    }
  }

  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  let lastLinePartial = false
  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (outputLinesArr.length > 0 ? 1 : 0)
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes)
        outputLinesArr.unshift(truncatedLine)
        outputBytesCount = Buffer.byteLength(truncatedLine, 'utf-8')
        lastLinePartial = true
      }
      break
    }
    outputLinesArr.unshift(line)
    outputBytesCount += lineBytes
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }
  const outputContent = outputLinesArr.join('\n')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf-8'),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  }
}
