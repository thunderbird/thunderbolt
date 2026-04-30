/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { deriveFaviconUrl, isSafeUrl } from './url-utils'

describe('isSafeUrl', () => {
  it('accepts http URLs', () => {
    expect(isSafeUrl('http://example.com')).toBe(true)
  })

  it('accepts https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
  })

  it('rejects javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects data: URLs', () => {
    expect(isSafeUrl('data:text/html,<h1>hi</h1>')).toBe(false)
  })

  it('rejects invalid URLs', () => {
    expect(isSafeUrl('not a url')).toBe(false)
  })
})

describe('deriveFaviconUrl', () => {
  it('derives /favicon.ico from page URL origin', () => {
    expect(deriveFaviconUrl('https://example.com/article/123')).toBe('https://example.com/favicon.ico')
  })

  it('preserves the URL scheme', () => {
    expect(deriveFaviconUrl('http://example.com/article')).toBe('http://example.com/favicon.ico')
  })

  it('returns null for invalid URLs', () => {
    expect(deriveFaviconUrl('not a url')).toBeNull()
  })
})
