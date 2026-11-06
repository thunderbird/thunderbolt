/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Sentence/clause aggregator (THU-687) — engine-agnostic, so both the
 * in-webview and native TTS backends reuse it.
 *
 * Buffers streaming LLM tokens and flushes speakable chunks to TTS. The
 * first chunk is split aggressively (at the earliest clause boundary past a
 * small floor, or a hard word-boundary cap) to minimize time-to-first-audio;
 * later chunks flush on sentence boundaries. Guards avoid false splits on
 * decimals, common abbreviations, and inline code.
 */

/** Emit the first chunk once it reaches this length and hits a clause break. */
const firstMinChars = 20
/** Hard cap on the first chunk — flush at the last word boundary by here. */
const firstMaxChars = 48

const clausePunct = new Set([',', ';', ':', '—', '–'])
const sentencePunct = new Set(['.', '!', '?'])
/** Lowercased tokens that end in a period but don't end a sentence. */
const abbreviations = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'eg',
  'ie',
  'ph',
  'approx',
  'no',
  'fig',
  'al',
])

const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'

/** True if the word ending at `dotIndex` (exclusive) is a known abbreviation. */
const precededByAbbreviation = (buffer: string, dotIndex: number): boolean => {
  let start = dotIndex
  while (start > 0 && /[A-Za-z]/.test(buffer[start - 1])) {
    start--
  }
  const word = buffer.slice(start, dotIndex).toLowerCase()
  return word.length > 0 && abbreviations.has(word)
}

export class SentenceAggregator {
  private buffer = ''
  private firstEmitted = false

  /** Feed streaming text; returns any chunks that became ready to synthesize. */
  push(text: string): string[] {
    this.buffer += text
    const chunks: string[] = []
    for (;;) {
      const end = this.nextBoundary()
      if (end < 0) {
        break
      }
      const chunk = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end)
      if (chunk.length > 0) {
        chunks.push(chunk)
        this.firstEmitted = true
      }
    }
    return chunks
  }

  /** Flush the remaining buffer at end-of-stream (e.g. after the LLM finishes). */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest.length === 0) {
      return []
    }
    this.firstEmitted = true
    return [rest]
  }

  /**
   * Index (exclusive) at which to cut the next chunk from the buffer, or -1
   * if no complete chunk is available yet.
   */
  private nextBoundary(): number {
    const buf = this.buffer
    let lastWordBreak = -1
    // Reset per scan: the buffer always begins outside a code span, because we
    // never cut at a boundary found while inside one. This relies on backticks
    // being balanced within the reply — a lone/unmatched backtick would flip
    // `inCode` and suppress all further splitting until `flush()`, delaying
    // time-to-audio for the rest of the turn. LLM inline code is reliably
    // balanced, so this is an accepted edge case rather than a guarded one.
    let inCode = false
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i]
      if (ch === '`') {
        inCode = !inCode
      }
      if (inCode) {
        continue
      }
      if (isWhitespace(ch)) {
        lastWordBreak = i
      }

      if (!this.firstEmitted) {
        // First chunk: earliest clause/sentence break past the floor, else a
        // hard cap at the last word boundary — bounds time-to-first-audio.
        if (i + 1 >= firstMinChars) {
          if (clausePunct.has(ch)) {
            return i + 1
          }
          const end = this.sentenceEnd(buf, i)
          if (end > 0) {
            return end
          }
        }
        if (i + 1 >= firstMaxChars && lastWordBreak > 0) {
          return lastWordBreak + 1
        }
        continue
      }

      const end = this.sentenceEnd(buf, i)
      if (end > 0) {
        return end
      }
    }
    return -1
  }

  /**
   * Exclusive end index if `buf[i]` closes a sentence (terminal punct, any
   * trailing quotes/brackets, then whitespace), or -1. Rejects decimals,
   * abbreviations, and URLs so they don't split mid-thought.
   */
  private sentenceEnd(buf: string, i: number): number {
    if (!sentencePunct.has(buf[i])) {
      return -1
    }
    // Consume any run of terminators / closing quotes+brackets.
    let j = i
    while (j + 1 < buf.length && (sentencePunct.has(buf[j + 1]) || `")']`.includes(buf[j + 1]))) {
      j++
    }
    // Must be followed by whitespace — excludes decimals (3.14) and URLs (a.com).
    if (j + 1 >= buf.length || !isWhitespace(buf[j + 1])) {
      return -1
    }
    if (buf[i] === '.') {
      if (i > 0 && isDigit(buf[i - 1]) && i + 1 < buf.length && isDigit(buf[i + 1])) {
        return -1
      }
      if (precededByAbbreviation(buf, i)) {
        return -1
      }
    }
    return j + 1
  }
}
