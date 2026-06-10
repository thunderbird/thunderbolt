/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isDataUrlIcon } from './icon-utils'

describe('isDataUrlIcon', () => {
  it('returns true for a JPEG data URL', () => {
    expect(isDataUrlIcon('data:image/jpeg;base64,/9j/4AAQ...')).toBe(true)
  })

  it('returns true for a PNG data URL', () => {
    expect(isDataUrlIcon('data:image/png;base64,iVBOR...')).toBe(true)
  })

  it('returns false for an emoji', () => {
    expect(isDataUrlIcon('🛠️')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isDataUrlIcon('')).toBe(false)
  })

  it('returns false for null / undefined', () => {
    expect(isDataUrlIcon(null)).toBe(false)
    expect(isDataUrlIcon(undefined)).toBe(false)
  })
})
