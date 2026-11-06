/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Max characters {@link detectStreamChunk} buffers before force-emitting when no
 * word boundary (whitespace) has appeared yet. Bounds whitespace-free runs — CJK
 * text, long URLs, minified JSON, long identifiers — so they keep streaming
 * incrementally instead of buffering until end-of-message. Whitespace-delimited
 * words up to this length always emit whole, so this only bites genuinely
 * space-free content.
 */
export const smoothStreamMaxChunkChars = 12

/**
 * Chunk detector for `smoothStream`'s `chunking` option (used by `runStreamText`
 * in `src/ai/fetch.ts`).
 *
 * The AI SDK's built-in `'word'` chunking (`/\S+\s+/`) only releases a chunk once
 * it sees trailing whitespace, so text without spaces — CJK/Thai scripts, long
 * URLs, minified JSON — buffers into a single jump at the end instead of
 * streaming. This detector keeps latin's word-by-word cadence (identical to
 * `'word'`: a whole word plus its trailing whitespace) but falls back to a
 * bounded {@link smoothStreamMaxChunkChars} slice once that many characters have
 * accumulated with no whitespace, so space-free content still flows smoothly.
 *
 * `smoothStream` requires the returned match to be a prefix of `buffer`; both
 * branches satisfy that. Returns `null` to wait for more input.
 */
export const detectStreamChunk = (buffer: string): string | null => {
  // Leading whitespace + first word + its trailing whitespace. Emitting the
  // whole match (never a partial word) keeps latin text breaking on word
  // boundaries regardless of word length.
  const word = /^\s*\S+\s+/.exec(buffer)
  if (word) {
    return word[0]
  }
  // No completed word yet. Once enough has buffered without any whitespace it's
  // space-free content — release a bounded slice so it keeps streaming.
  if (buffer.length >= smoothStreamMaxChunkChars) {
    return buffer.slice(0, smoothStreamMaxChunkChars)
  }
  return null
}
