/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { describe, expect, test } from 'bun:test'
import { extractTextFromParts } from './message-utils'

const textPart = (text: string): UIMessage['parts'][number] => ({ type: 'text', text }) as UIMessage['parts'][number]

describe('extractTextFromParts', () => {
  test('returns empty string when message has no text parts', () => {
    expect(extractTextFromParts([])).toBe('')
  })

  test('returns empty string when text parts contain only widgets with URL slashes', () => {
    const parts = [
      textPart('<widget:link-preview url="https://reuters.com/tech/foo" />'),
      textPart('<widget:link-preview url="https://apnews.com/article/bar" />'),
    ]
    expect(extractTextFromParts(parts)).toBe('')
  })

  test('returns empty string for widget with multiple attributes including slashes', () => {
    const parts = [textPart('<widget:link-preview source="1" url="https://example.com/path/to/page" />')]
    expect(extractTextFromParts(parts)).toBe('')
  })

  test('returns empty string for inline citations only', () => {
    expect(extractTextFromParts([textPart('[1] [2] [3]')])).toBe('')
  })

  test('returns trimmed text for regular text parts', () => {
    expect(extractTextFromParts([textPart('Hello world')])).toBe('Hello world')
  })

  test('strips widgets but keeps surrounding text', () => {
    const parts = [textPart('Here is the news: <widget:link-preview url="https://x.com/a/b" /> read more.')]
    expect(extractTextFromParts(parts)).toBe('Here is the news:  read more.')
  })

  test('joins multiple non-empty text parts with separator', () => {
    expect(extractTextFromParts([textPart('first'), textPart('second')])).toBe('first\n\nsecond')
  })
})
