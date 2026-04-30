/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { extractFaviconUrl } from './tool-icon'

describe('tool-icon helpers', () => {
  describe('extractFaviconUrl', () => {
    it('should return null for non-favicon tools', () => {
      expect(extractFaviconUrl('get_weather', { temp: 72 })).toBe(null)
      expect(extractFaviconUrl('google_get_email', { subject: 'test' })).toBe(null)
      expect(extractFaviconUrl('custom_tool', { result: 'ok' })).toBe(null)
    })

    it('should extract favicon from fetch_content output', () => {
      const output = {
        content: 'Example content',
        favicon: 'https://example.com/favicon.ico',
      }
      expect(extractFaviconUrl('fetch_content', output)).toBe('https://example.com/favicon.ico')
    })

    it('should extract favicon from search output array', () => {
      const output = [
        {
          title: 'First Result',
          url: 'https://example.com',
          favicon: 'https://example.com/favicon.ico',
        },
        {
          title: 'Second Result',
          url: 'https://other.com',
          favicon: 'https://other.com/favicon.ico',
        },
      ]
      expect(extractFaviconUrl('search', output)).toBe('https://example.com/favicon.ico')
    })

    it('should return null if favicon is missing from fetch_content output', () => {
      const output = {
        content: 'Example content',
      }
      expect(extractFaviconUrl('fetch_content', output)).toBe(null)
    })

    it('should return null if search output array is empty', () => {
      expect(extractFaviconUrl('search', [])).toBe(null)
    })

    it('should return null if first search result has no favicon', () => {
      const output = [
        {
          title: 'First Result',
          url: 'https://example.com',
        },
      ]
      expect(extractFaviconUrl('search', output)).toBe(null)
    })

    it('should handle JSON string input', () => {
      const output = JSON.stringify({
        content: 'Example',
        favicon: 'https://example.com/favicon.ico',
      })
      expect(extractFaviconUrl('fetch_content', output)).toBe('https://example.com/favicon.ico')
    })

    it('should handle JSON string array input', () => {
      const output = JSON.stringify([
        {
          favicon: 'https://example.com/favicon.ico',
        },
      ])
      expect(extractFaviconUrl('search', output)).toBe('https://example.com/favicon.ico')
    })

    it('should return null for malformed output', () => {
      expect(extractFaviconUrl('fetch_content', null)).toBe(null)
      expect(extractFaviconUrl('fetch_content', undefined)).toBe(null)
      expect(extractFaviconUrl('search', null)).toBe(null)
    })
  })

  /**
   * Note: useToolFavicon hook composition is exercised via:
   * 1. The Storybook stories (tool-icon.stories.tsx)
   * 2. The proxy URL helper unit tests (src/lib/proxy-url.test.ts)
   * 3. The favicon e2e spec (e2e/proxy-favicon.spec.ts) which verifies the
   *    rendered <img> hits /v1/proxy/<encoded> end-to-end.
   */
})
