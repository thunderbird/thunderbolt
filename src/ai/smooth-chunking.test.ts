/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { detectStreamChunk, smoothStreamMaxChunkChars } from './smooth-chunking'

/**
 * Mimic smoothStream's drain: repeatedly pull the detected chunk off the front
 * of a growing buffer until no more can be detected, returning the emitted
 * chunks plus whatever remains buffered (flushed at stream end).
 */
const drain = (buffer: string): { chunks: string[]; remainder: string } => {
  const chunks: string[] = []
  let rest = buffer
  let match = detectStreamChunk(rest)
  while (match != null) {
    // smoothStream rejects a match that isn't a prefix of the buffer.
    expect(rest.startsWith(match)).toBe(true)
    expect(match.length).toBeGreaterThan(0)
    chunks.push(match)
    rest = rest.slice(match.length)
    match = detectStreamChunk(rest)
  }
  return { chunks, remainder: rest }
}

describe('detectStreamChunk', () => {
  it('emits a whole latin word with its trailing whitespace', () => {
    expect(detectStreamChunk('hello world')).toBe('hello ')
  })

  it('keeps leading whitespace in the match so it stays a prefix of the buffer', () => {
    expect(detectStreamChunk('  hello world')).toBe('  hello ')
  })

  it('never splits a whitespace-terminated word, even one longer than the cap', () => {
    const longWord = 'internationalization '
    expect(longWord.length).toBeGreaterThan(smoothStreamMaxChunkChars)
    expect(detectStreamChunk(longWord)).toBe(longWord)
  })

  it('waits (returns null) for a short unterminated word so it is not split prematurely', () => {
    expect(detectStreamChunk('hi')).toBeNull()
  })

  it('force-emits a bounded slice for a long whitespace-free run (CJK)', () => {
    const cjk = '你好世界今天天气很好啊真的很好' // no spaces, length > cap
    expect(cjk.length).toBeGreaterThan(smoothStreamMaxChunkChars)
    expect(detectStreamChunk(cjk)).toBe(cjk.slice(0, smoothStreamMaxChunkChars))
  })

  it('force-emits a bounded slice for a long space-free ascii run (URL/minified)', () => {
    const url = 'https://example.com/a/very/long/path/without/spaces'
    expect(detectStreamChunk(url)).toBe(url.slice(0, smoothStreamMaxChunkChars))
  })

  it('drains latin prose word-by-word with no data loss', () => {
    const text = 'The quick brown fox jumps '
    const { chunks, remainder } = drain(text)
    expect(chunks).toEqual(['The ', 'quick ', 'brown ', 'fox ', 'jumps '])
    expect(remainder).toBe('')
  })

  it('drains a space-free CJK run into bounded chunks and reconstructs exactly', () => {
    const cjk = '你好世界今天天气很好啊真的非常好' // 16 chars, no spaces
    const { chunks, remainder } = drain(cjk)
    // Every emitted chunk is bounded by the cap; nothing is lost across
    // emitted chunks + the buffered remainder (which smoothStream flushes at end).
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(smoothStreamMaxChunkChars)
    }
    expect(chunks.join('') + remainder).toBe(cjk)
    expect(chunks.length).toBeGreaterThan(0)
  })
})
