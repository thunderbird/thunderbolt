/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { foldForMatch } from './fold'

/** Slices the original text back out of a folded span, the way highlight does. */
const sliceOriginal = (text: string, needle: string): string | null => {
  const { folded, offsets } = foldForMatch(text)
  const at = folded.indexOf(needle)
  return at === -1 ? null : text.slice(offsets[at], offsets[at + needle.length])
}

describe('foldForMatch', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldForMatch('São Paulo').folded).toBe('sao paulo')
    expect(foldForMatch('Köln').folded).toBe('koln')
    expect(foldForMatch('MÜLLER').folded).toBe('muller')
  })

  it('leaves unsegmented scripts alone', () => {
    expect(foldForMatch('東京の天気').folded).toBe('東京の天気')
  })

  it('leaves Japanese dakuten intact — が is not か', () => {
    // Matches the tokenizer: `remove_diacritics 2` does not fold kana voicing.
    expect(foldForMatch('が').folded).toBe('が')
    expect(foldForMatch('が').folded).not.toBe('か')
  })

  it('keeps one offset per UTF-16 unit of the folded output', () => {
    const { folded, offsets } = foldForMatch('São')
    expect(offsets).toHaveLength(folded.length + 1)
    expect(offsets[offsets.length - 1]).toBe('São'.length)
  })

  it('maps a folded span back onto the accented original', () => {
    expect(sliceOriginal('weather in São Paulo', 'sao')).toBe('São')
  })

  it('maps back across a decomposed combining mark', () => {
    // The folded form is one unit shorter than the original span.
    expect(sliceOriginal('café open', 'cafe')).toBe('café')
  })

  it('maps back across a surrogate pair without splitting it', () => {
    expect(sliceOriginal('🎉 party', 'party')).toBe('party')
    expect(sliceOriginal('a🎉b', 'a')).toBe('a')
    expect(sliceOriginal('a🎉b', 'b')).toBe('b')
  })

  it('keeps Thai vowel signs, which are marks but not decoration', () => {
    const thai = 'สวัสดี'
    expect(foldForMatch(thai).folded).toBe(thai)
  })

  it('keeps Devanagari matras', () => {
    const devanagari = 'नमस्ते'
    expect(foldForMatch(devanagari).folded).toBe(devanagari)
  })

  it('still folds accents when they follow a non-accented script', () => {
    // The strip decision is per base character, not per string.
    expect(foldForMatch('天気 São').folded).toBe('天気 sao')
  })

  it('handles an empty string', () => {
    expect(foldForMatch('')).toEqual({ folded: '', offsets: [0] })
  })
})
