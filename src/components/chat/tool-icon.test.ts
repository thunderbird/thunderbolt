/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { extractFaviconUrl } from './tool-icon'

describe('extractFaviconUrl', () => {
  it('returns null for non-favicon tools', () => {
    expect(extractFaviconUrl('get_weather', { temp: 72 })).toBe(null)
    expect(extractFaviconUrl('google_get_email', { subject: 'test' })).toBe(null)
    expect(extractFaviconUrl('custom_tool', { result: 'ok' })).toBe(null)
  })

  it('extracts favicon from fetch_content output', () => {
    const output = { content: 'Example content', favicon: 'https://example.com/favicon.ico' }
    expect(extractFaviconUrl('fetch_content', output)).toBe('https://example.com/favicon.ico')
  })

  it('extracts favicon from search output array', () => {
    const output = [
      { title: 'First', url: 'https://example.com', favicon: 'https://example.com/favicon.ico' },
      { title: 'Second', url: 'https://other.com', favicon: 'https://other.com/favicon.ico' },
    ]
    expect(extractFaviconUrl('search', output)).toBe('https://example.com/favicon.ico')
  })

  it('returns null when favicon is missing', () => {
    expect(extractFaviconUrl('fetch_content', { content: 'no fav' })).toBe(null)
    expect(extractFaviconUrl('search', [])).toBe(null)
    expect(extractFaviconUrl('search', [{ title: 'no fav' }])).toBe(null)
  })

  it('handles JSON string input', () => {
    expect(extractFaviconUrl('fetch_content', JSON.stringify({ favicon: 'https://x.com/f.ico' }))).toBe(
      'https://x.com/f.ico',
    )
  })

  it('returns null for malformed input', () => {
    expect(extractFaviconUrl('fetch_content', null)).toBe(null)
    expect(extractFaviconUrl('fetch_content', undefined)).toBe(null)
  })
})
