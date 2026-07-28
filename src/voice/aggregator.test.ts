/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { SentenceAggregator } from './aggregator'

/** Push text one character at a time (worst-case token granularity), then flush. */
const runStreamed = (text: string): string[] => {
  const agg = new SentenceAggregator()
  const chunks: string[] = []
  for (const ch of text) {
    chunks.push(...agg.push(ch))
  }
  chunks.push(...agg.flush())
  return chunks
}

describe('SentenceAggregator', () => {
  test('emits the first chunk at the earliest clause break past the floor', () => {
    const chunks = runStreamed('Well, that is a genuinely interesting question, and here is the answer. ')
    // First clause after the 20-char floor is the comma after "question".
    expect(chunks[0]).toBe('Well, that is a genuinely interesting question,')
    expect(chunks[1]).toBe('and here is the answer.')
  })

  test('splits subsequent chunks on sentence boundaries', () => {
    const chunks = runStreamed('The first sentence is here. The second follows. The third ends it. ')
    expect(chunks).toEqual(['The first sentence is here.', 'The second follows.', 'The third ends it.'])
  })

  test('flush emits a trailing sentence with no terminating whitespace', () => {
    const chunks = runStreamed('No trailing space here.')
    expect(chunks).toEqual(['No trailing space here.'])
  })

  test('does not split decimals', () => {
    const chunks = runStreamed('The value is 3.14 and pi is 3.14159 exactly. ')
    expect(chunks).toEqual(['The value is 3.14 and pi is 3.14159 exactly.'])
  })

  // The guard cases below lead with a full sentence (≥20 chars, ends before the
  // first-chunk cap) so the guard-under-test runs on a *subsequent* chunk, which
  // has no length cap — isolating the sentence-split guard from first-chunk logic.
  test('does not split on common title abbreviations', () => {
    const chunks = runStreamed('Here is the plan for today. Dr. Smith met Mr. Jones this morning. ')
    expect(chunks).toEqual(['Here is the plan for today.', 'Dr. Smith met Mr. Jones this morning.'])
  })

  test('does not split inside inline code spans', () => {
    const chunks = runStreamed('Let me show you the command now. Run `git commit -m "v1.2. done"` and push. ')
    expect(chunks).toEqual(['Let me show you the command now.', 'Run `git commit -m "v1.2. done"` and push.'])
  })

  test('does not split inside a URL', () => {
    const chunks = runStreamed('Here is a useful link for you. Open example.com and read the docs. ')
    expect(chunks).toEqual(['Here is a useful link for you.', 'Open example.com and read the docs.'])
  })

  test('keeps closing punctuation with the sentence', () => {
    const chunks = runStreamed('She said "hello there friend." Then she left the room. ')
    expect(chunks).toEqual(['She said "hello there friend."', 'Then she left the room.'])
  })

  test('caps a long, punctuation-free first chunk at a word boundary', () => {
    const chunks = runStreamed('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo. ')
    // First chunk cut at the last word boundary before the 48-char cap.
    expect(chunks[0].length).toBeLessThanOrEqual(48)
    expect(chunks[0].endsWith(' ')).toBe(false)
    // Nothing dropped across the whole stream.
    expect(chunks.join(' ')).toContain('kilo.')
  })

  test('flush on empty buffer yields nothing', () => {
    const agg = new SentenceAggregator()
    expect(agg.flush()).toEqual([])
  })
})
