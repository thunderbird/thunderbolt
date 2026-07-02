/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `edit-apply` tests — focused on the empty/whitespace-only oldText guard. A
 * whitespace-only oldText is non-empty after LF normalization but collapses to ''
 * under fuzzy normalization, so it must be rejected up front rather than fuzzy-
 * matching at index 0.
 */

import { describe, expect, it } from 'bun:test'
import { applyEditsToNormalizedContent } from './edit-apply.ts'

describe('applyEditsToNormalizedContent', () => {
  it('applies a straightforward exact replacement', () => {
    const { newContent } = applyEditsToNormalizedContent('hello world', [{ oldText: 'world', newText: 'pi' }], 'f.txt')
    expect(newContent).toBe('hello pi')
  })

  it('rejects an empty oldText', () => {
    expect(() => applyEditsToNormalizedContent('abc', [{ oldText: '', newText: 'x' }], 'f.txt')).toThrow(
      'oldText must not be empty',
    )
  })

  it('rejects a whitespace-only oldText (collapses to empty under fuzzy match)', () => {
    expect(() => applyEditsToNormalizedContent('a    b', [{ oldText: '   ', newText: 'x' }], 'f.txt')).toThrow(
      'oldText must not be empty',
    )
  })

  it('rejects a tab-only oldText', () => {
    expect(() => applyEditsToNormalizedContent('a\tb', [{ oldText: '\t', newText: 'x' }], 'f.txt')).toThrow(
      'oldText must not be empty',
    )
  })

  it('still accepts a newline-only oldText (fuzzy keeps the newline)', () => {
    const { newContent } = applyEditsToNormalizedContent('a\n\nb', [{ oldText: '\n\n', newText: '\n' }], 'f.txt')
    expect(newContent).toBe('a\nb')
  })
})
