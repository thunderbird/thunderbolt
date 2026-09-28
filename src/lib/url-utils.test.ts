/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { deriveFaviconUrl, isSafeUrl, normalizeBackendUrl, resolveAbsoluteBackendUrl } from './url-utils'

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
  it('derives /favicon.ico from a HTTPS page URL origin', () => {
    expect(deriveFaviconUrl('https://example.com/article/123')).toBe('https://example.com/favicon.ico')
  })

  it('returns null for HTTP-only URLs (mixed content)', () => {
    expect(deriveFaviconUrl('http://example.com')).toBeNull()
  })

  it('returns null for invalid URLs', () => {
    expect(deriveFaviconUrl('not a url')).toBeNull()
  })
})

describe('normalizeBackendUrl', () => {
  it('removes only trailing slashes from relative and absolute backend URLs', () => {
    expect(normalizeBackendUrl('/v1')).toBe('/v1')
    expect(normalizeBackendUrl('/v1/')).toBe('/v1')
    expect(normalizeBackendUrl('/v1///')).toBe('/v1')
    expect(normalizeBackendUrl('https://api.example.test/v1')).toBe('https://api.example.test/v1')
    expect(normalizeBackendUrl('https://api.example.test/v1///')).toBe('https://api.example.test/v1')
    expect(normalizeBackendUrl('https://api.example.test/v1//agents')).toBe('https://api.example.test/v1//agents')
  })
})

describe('resolveAbsoluteBackendUrl', () => {
  it('resolves a same-origin relative path against the page origin', () => {
    expect(resolveAbsoluteBackendUrl('/v1', 'https://app.example.com')).toBe('https://app.example.com/v1')
  })

  it('leaves an already-absolute URL unchanged (local dev, cross-origin preview stacks)', () => {
    expect(resolveAbsoluteBackendUrl('http://localhost:8000/v1', 'https://ignored.example.com')).toBe(
      'http://localhost:8000/v1',
    )
  })

  it('strips every trailing slash, not just the last one', () => {
    expect(resolveAbsoluteBackendUrl('/v1//', 'https://app.example.com')).toBe('https://app.example.com/v1')
  })

  it('defaults to the page origin, which is the only form the app itself uses', () => {
    const previousHref = window.location.href
    window.location.href = 'https://app.example.com/settings/models'
    try {
      expect(resolveAbsoluteBackendUrl('/v1')).toBe('https://app.example.com/v1')
    } finally {
      window.location.href = previousHref
    }
  })
})
