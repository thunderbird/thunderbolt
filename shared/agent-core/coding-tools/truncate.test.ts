/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `truncate` tests — the head/tail truncation algorithm is a pure function whose
 * exact contract ("first/last N lines or KKB, whichever is hit first") the model's
 * priors depend on. These exercise the boundaries exhaustively: empty input,
 * exactly-at-limit vs one-over for BOTH the line and byte limits, which-limit-wins,
 * UTF-8 byte accounting (multibyte chars), the head-specific `firstLineExceedsLimit`
 * escape, and the tail-specific partial-last-line path with UTF-8 boundary safety.
 */

import { describe, expect, it } from 'bun:test'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from './truncate.ts'

describe('formatSize', () => {
  it('renders sub-KB byte counts with a B suffix', () => {
    expect(formatSize(0)).toBe('0B')
    expect(formatSize(1)).toBe('1B')
    expect(formatSize(1023)).toBe('1023B')
  })

  it('switches to KB exactly at 1024 bytes with one decimal', () => {
    expect(formatSize(1024)).toBe('1.0KB')
    expect(formatSize(1536)).toBe('1.5KB')
    expect(formatSize(DEFAULT_MAX_BYTES)).toBe('50.0KB')
  })

  it('switches to MB exactly at 1024*1024 bytes', () => {
    expect(formatSize(1024 * 1024 - 1)).toBe('1024.0KB')
    expect(formatSize(1024 * 1024)).toBe('1.0MB')
    expect(formatSize(3 * 1024 * 1024 + 512 * 1024)).toBe('3.5MB')
  })
})

describe('truncateHead', () => {
  it('returns empty content untruncated (line count is 0, not 1)', () => {
    const r = truncateHead('')
    expect(r.truncated).toBe(false)
    expect(r.content).toBe('')
    expect(r.totalLines).toBe(0)
    expect(r.outputLines).toBe(0)
    expect(r.truncatedBy).toBeNull()
  })

  it('does not truncate exactly at the line limit', () => {
    const content = Array.from({ length: 3 }, (_, i) => `l${i}`).join('\n')
    const r = truncateHead(content, { maxLines: 3 })
    expect(r.truncated).toBe(false)
    expect(r.content).toBe(content)
    expect(r.outputLines).toBe(3)
  })

  it('truncates one line over the line limit, keeping the FIRST maxLines lines', () => {
    const r = truncateHead('a\nb\nc', { maxLines: 2 })
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('lines')
    expect(r.content).toBe('a\nb')
    expect(r.outputLines).toBe(2)
    expect(r.totalLines).toBe(3)
  })

  it('does not truncate when total bytes equal the byte limit exactly', () => {
    // 'aaa\nbbb' = 7 bytes.
    const r = truncateHead('aaa\nbbb', { maxBytes: 7 })
    expect(r.truncated).toBe(false)
    expect(r.totalBytes).toBe(7)
  })

  it('truncates one byte over the byte limit, dropping whole trailing lines', () => {
    const r = truncateHead('aaa\nbbb', { maxBytes: 6 })
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('bytes')
    expect(r.content).toBe('aaa')
    expect(r.outputLines).toBe(1)
  })

  it('flags firstLineExceedsLimit (empty content) when line 1 alone is over the byte limit', () => {
    const r = truncateHead('aaaaa\nb', { maxBytes: 3 })
    expect(r.truncated).toBe(true)
    expect(r.firstLineExceedsLimit).toBe(true)
    expect(r.content).toBe('')
    expect(r.outputLines).toBe(0)
    expect(r.truncatedBy).toBe('bytes')
  })

  it('counts bytes (not chars) for multibyte content at the byte boundary', () => {
    // '€' is 3 UTF-8 bytes; '€\n€' = 7 bytes. maxBytes 4 fits only the first line.
    const r = truncateHead('€\n€', { maxBytes: 4 })
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('bytes')
    expect(r.content).toBe('€')
    expect(r.outputBytes).toBe(3)
  })

  it('reports the line limit as the cause when lines run out before bytes do', () => {
    const content = Array.from({ length: 5 }, () => 'x').join('\n')
    const r = truncateHead(content, { maxLines: 2, maxBytes: 1000 })
    expect(r.truncatedBy).toBe('lines')
    expect(r.content).toBe('x\nx')
  })

  it('attributes truncation to lines when BOTH limits are exceeded but the line limit is hit first', () => {
    // 5 lines of 'a' = 9 bytes total, over BOTH maxLines:2 and maxBytes:5. The 2
    // emitted lines ('a\na' = 3 bytes) fit under maxBytes, so the post-loop
    // reassignment must label the cause 'lines', not 'bytes'.
    const content = Array.from({ length: 5 }, () => 'a').join('\n')
    const r = truncateHead(content, { maxLines: 2, maxBytes: 5 })
    expect(r.truncatedBy).toBe('lines')
    expect(r.content).toBe('a\na')
    expect(r.outputLines).toBe(2)
  })

  it('drops the trailing empty line produced by a final newline when counting', () => {
    const r = truncateHead('a\nb\n')
    expect(r.truncated).toBe(false)
    expect(r.totalLines).toBe(2)
    expect(r.content).toBe('a\nb\n') // content is returned verbatim, newline preserved
    expect(r.outputLines).toBe(2)
  })

  it('uses the default limits when no options are passed', () => {
    const content = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `${i}`).join('\n')
    const r = truncateHead(content)
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('lines')
    expect(r.outputLines).toBe(DEFAULT_MAX_LINES)
    expect(r.maxBytes).toBe(DEFAULT_MAX_BYTES)
  })
})

describe('truncateTail', () => {
  it('returns empty content untruncated', () => {
    const r = truncateTail('')
    expect(r.truncated).toBe(false)
    expect(r.content).toBe('')
    expect(r.totalLines).toBe(0)
  })

  it('does not truncate exactly at the line limit', () => {
    const r = truncateTail('a\nb\nc', { maxLines: 3 })
    expect(r.truncated).toBe(false)
    expect(r.content).toBe('a\nb\nc')
  })

  it('keeps the LAST maxLines lines when over the line limit', () => {
    const r = truncateTail('a\nb\nc', { maxLines: 2 })
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('lines')
    expect(r.content).toBe('b\nc')
    expect(r.outputLines).toBe(2)
    expect(r.lastLinePartial).toBe(false)
  })

  it('keeps the LAST whole lines when over the byte limit', () => {
    const r = truncateTail('aaa\nbbb\nccc', { maxBytes: 5 })
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('bytes')
    expect(r.content).toBe('ccc')
    expect(r.lastLinePartial).toBe(false)
  })

  it('returns a PARTIAL first line (kept from the end) when the last line alone exceeds the byte limit', () => {
    const r = truncateTail('hello', { maxBytes: 3 })
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('bytes')
    expect(r.lastLinePartial).toBe(true)
    expect(r.content).toBe('llo')
    expect(r.outputBytes).toBe(3)
  })

  it('respects UTF-8 character boundaries when partial-truncating the last line', () => {
    // '€€€' = 9 bytes. maxBytes 4 cannot fit two whole chars (6 bytes), so it keeps
    // one whole '€' (3 bytes) rather than slicing mid-codepoint.
    const r = truncateTail('€€€', { maxBytes: 4 })
    expect(r.lastLinePartial).toBe(true)
    expect(r.content).toBe('€')
    expect(r.outputBytes).toBe(3)
  })

  it('returns EMPTY partial content when the byte limit is smaller than one multibyte char', () => {
    // '€' is 3 bytes; maxBytes 2 can fit none of it without splitting a codepoint, so
    // the boundary walk drops the whole char, yielding empty (but still partial) content.
    const r = truncateTail('€', { maxBytes: 2 })
    expect(r.truncated).toBe(true)
    expect(r.lastLinePartial).toBe(true)
    expect(r.content).toBe('')
    expect(r.outputBytes).toBe(0)
  })

  it('attributes truncation to lines when BOTH limits are exceeded but the line limit caps the output', () => {
    // 5 lines of 'a' = 9 bytes, over both maxLines:2 and maxBytes:5. The kept last
    // 2 lines ('a\na' = 3 bytes) fit, so the cause is 'lines', not 'bytes'.
    const content = Array.from({ length: 5 }, () => 'a').join('\n')
    const r = truncateTail(content, { maxLines: 2, maxBytes: 5 })
    expect(r.truncatedBy).toBe('lines')
    expect(r.content).toBe('a\na')
    expect(r.lastLinePartial).toBe(false)
  })

  it('does not truncate when total bytes equal the byte limit exactly', () => {
    const r = truncateTail('aaa\nbbb', { maxBytes: 7 })
    expect(r.truncated).toBe(false)
  })

  it('uses the default limits when no options are passed', () => {
    const content = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `${i}`).join('\n')
    const r = truncateTail(content)
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('lines')
    expect(r.outputLines).toBe(DEFAULT_MAX_LINES)
    // The last line is retained, the first dropped.
    expect(r.content.endsWith(`${DEFAULT_MAX_LINES}`)).toBe(true)
    expect(r.content.startsWith('0\n')).toBe(false)
  })
})
