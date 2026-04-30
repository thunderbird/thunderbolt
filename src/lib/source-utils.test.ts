/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { deriveSiteName, sourceToCitation } from './source-utils'
import type { SourceMetadata } from '@/types/source'

describe('sourceToCitation', () => {
  test('maps SourceMetadata to CitationSource with all fields', () => {
    const source: SourceMetadata = {
      index: 3,
      url: 'https://example.com/article',
      title: 'Example Article',
      description: 'A great article',
      image: 'https://example.com/img.png',
      favicon: 'https://example.com/favicon.ico',
      siteName: 'example.com',
      author: 'John Doe',
      publishedDate: '2025-01-01',
      toolName: 'search',
    }

    const citation = sourceToCitation(source)

    expect(citation).toEqual({
      id: '3',
      title: 'Example Article',
      url: 'https://example.com/article',
      siteName: 'example.com',
      favicon: 'https://example.com/favicon.ico',
      isPrimary: true,
    })
  })

  test('converts null favicon to undefined', () => {
    const source: SourceMetadata = {
      index: 1,
      url: 'https://example.com',
      title: 'Example',
      favicon: null,
      toolName: 'fetch_content',
    }

    const citation = sourceToCitation(source)

    expect(citation.favicon).toBeUndefined()
  })

  test('handles missing optional fields', () => {
    const source: SourceMetadata = {
      index: 1,
      url: 'https://example.com',
      title: 'Example',
      toolName: 'search',
    }

    const citation = sourceToCitation(source)

    expect(citation).toEqual({
      id: '1',
      title: 'Example',
      url: 'https://example.com',
      siteName: undefined,
      favicon: undefined,
      isPrimary: true,
    })
  })

  test('respects isPrimary override when set to false', () => {
    const source: SourceMetadata = {
      index: 2,
      url: 'https://example.com',
      title: 'Example',
      toolName: 'search',
    }

    const citation = sourceToCitation(source, false)

    expect(citation.isPrimary).toBe(false)
  })
})

describe('deriveSiteName', () => {
  test('extracts hostname from a valid URL', () => {
    expect(deriveSiteName('https://example.com/path')).toBe('example.com')
  })

  test('strips www. prefix', () => {
    expect(deriveSiteName('https://www.example.com/path')).toBe('example.com')
  })

  test('preserves subdomain that is not www', () => {
    expect(deriveSiteName('https://blog.example.com')).toBe('blog.example.com')
  })

  test('returns undefined for invalid URL', () => {
    expect(deriveSiteName('not-a-url')).toBeUndefined()
  })

  test('returns undefined for empty string', () => {
    expect(deriveSiteName('')).toBeUndefined()
  })

  test('handles URLs with ports', () => {
    expect(deriveSiteName('https://example.com:8080/path')).toBe('example.com')
  })
})
