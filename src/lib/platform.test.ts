/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { isPrPreview, prPreviewHostRegex } from './platform'

describe('prPreviewHostRegex', () => {
  it('matches thunderbolt-pr-{number}.onrender.com hostnames', () => {
    expect(prPreviewHostRegex.test('thunderbolt-pr-368.onrender.com')).toBe(true)
    expect(prPreviewHostRegex.test('thunderbolt-pr-1.onrender.com')).toBe(true)
    expect(prPreviewHostRegex.test('thunderbolt-pr-9999.onrender.com')).toBe(true)
  })

  it('rejects non-matching hostnames', () => {
    expect(prPreviewHostRegex.test('thunderbolt.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('thunderbolt-pr.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('thunderbolt-pr-368x.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('localhost')).toBe(false)
    expect(prPreviewHostRegex.test('')).toBe(false)
  })
})

describe('isPrPreview', () => {
  const originalLocation = window.location

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    })
  })

  it('returns true when hostname matches PR preview pattern', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'thunderbolt-pr-368.onrender.com' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(true)
  })

  it('returns false when hostname does not match', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'localhost' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(false)
  })
})
