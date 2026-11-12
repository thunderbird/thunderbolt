/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getMemoryUsage, maxMemoryBytes, MemoryValidationError, validateMemoryContent } from './limits'

describe('memory document budget', () => {
  it('allows freeform text, empty documents, long paragraphs, and many lines', () => {
    for (const content of ['', ' ', 'x'.repeat(1000), 'line\n'.repeat(100)]) {
      expect(() => validateMemoryContent(content)).not.toThrow()
    }
  })

  it('counts Unicode characters separately from UTF-8 bytes', () => {
    expect(getMemoryUsage('🙂\n中')).toEqual({ characters: 3, bytes: 8 })
    expect(getMemoryUsage('e\u0301👨‍👩‍👧‍👦')).toEqual({ characters: 2, bytes: 28 })
    expect(maxMemoryBytes).toBe(6144)
    expect(() => validateMemoryContent('🙂'.repeat(1536))).not.toThrow()
    expect(() => validateMemoryContent('🙂'.repeat(1537))).toThrow(MemoryValidationError)
    expect(() => validateMemoryContent('x'.repeat(6145))).toThrow(MemoryValidationError)
  })
})
