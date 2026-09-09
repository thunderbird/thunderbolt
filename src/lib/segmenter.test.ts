/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { graphemeSegmenter, wordSegmenterFor } from './segmenter'

/** Word-like segments of `text`, the shape both consumers actually read. */
const words = (text: string): string[] =>
  [...(wordSegmenterFor(text)?.segment(text) ?? [])]
    .filter((part) => part.isWordLike === true)
    .map((part) => part.segment)

describe('wordSegmenterFor', () => {
  test('splits scripts that do not space their words', () => {
    // Asserting the count, not the cuts: which word ICU breaks on is its data.
    expect(words('東京の天気はどうですか').length).toBeGreaterThan(1)
    expect(words('ฉันต้องการแก้ไขกฎ').length).toBeGreaterThan(1)
    expect(words('ការពិនិត្យឡើងវិញ').length).toBeGreaterThan(1)
  })

  test('reuses one segmenter per script, so the dictionary is chosen once', () => {
    // Same instance for two kana texts, a different one for Latin — which is
    // how the script→dictionary mapping is observable without pinning ICU data.
    expect(wordSegmenterFor('同期ルール')).toBe(wordSegmenterFor('別のかな'))
    expect(wordSegmenterFor('hello there')).not.toBe(wordSegmenterFor('同期ルール'))
  })

  test('treats Han without kana as Chinese and Han with kana as Japanese', () => {
    expect(wordSegmenterFor('修复同步规则')).not.toBe(wordSegmenterFor('修正するルール'))
  })

  test('leaves spaced scripts on one shared segmenter', () => {
    // UAX #29 word breaking carries no dictionary for spaced scripts, so the
    // locale tag is immaterial and English, German and Portuguese share one.
    expect(wordSegmenterFor('the failing tests')).toBe(wordSegmenterFor('die fehlgeschlagenen Tests'))
    expect(words('PowerSync sync rules on iOS')).toEqual(['PowerSync', 'sync', 'rules', 'on', 'iOS'])
  })
})

describe('graphemeSegmenter', () => {
  test('keeps a ZWJ sequence together as one grapheme', () => {
    const segments = [...(graphemeSegmenter()?.segment('👨‍👩‍👧‍👦ok') ?? [])].map((part) => part.segment)
    expect(segments).toEqual(['👨‍👩‍👧‍👦', 'o', 'k'])
  })

  test('keeps a combining mark with the letter it modifies', () => {
    const segments = [...(graphemeSegmenter()?.segment('é') ?? [])].map((part) => part.segment)
    expect(segments).toEqual(['é'])
  })

  test('is memoized', () => {
    expect(graphemeSegmenter()).toBe(graphemeSegmenter())
  })
})
