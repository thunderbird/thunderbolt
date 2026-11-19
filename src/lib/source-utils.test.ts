/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { collectThreadSources, deriveSiteName, findSourceByIndex, sourceToCitation } from './source-utils'
import type { ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { decodeCitationSources } from './citation-utils'

const makeSource = (index: number, url = `https://example.com/${index}`): SourceMetadata => ({
  index,
  url,
  title: `Source ${index}`,
  toolName: 'search',
})

describe('findSourceByIndex', () => {
  test('matches on the index field, not array position', () => {
    const sources = [makeSource(4), makeSource(5)]

    expect(findSourceByIndex(sources, 5)).toBe(sources[1])
    expect(findSourceByIndex(sources, 1)).toBeUndefined()
  })

  test('prefers the latest entry when two turns reused a number', () => {
    const older = makeSource(2, 'https://older.test')
    const newer = makeSource(2, 'https://newer.test')

    expect(findSourceByIndex([older, newer], 2)).toBe(newer)
  })
})

describe('collectThreadSources', () => {
  test('gathers assistant sources in thread order and skips messages without any', () => {
    const first = makeSource(1)
    const second = makeSource(2)
    const messages = [
      { id: 'u1', role: 'user', parts: [] },
      { id: 'a1', role: 'assistant', parts: [], metadata: { sources: [first] } },
      { id: 'u2', role: 'user', parts: [], metadata: { sources: [makeSource(9)] } },
      { id: 'a2', role: 'assistant', parts: [] },
      { id: 'a3', role: 'assistant', parts: [], metadata: { sources: [second] } },
    ] as ThunderboltUIMessage[]

    expect(collectThreadSources(messages)).toEqual([first, second])
  })

  test('returns an empty list for a fresh thread', () => {
    expect(collectThreadSources([])).toEqual([])
  })
})

describe('sourceToCitation', () => {
  test('preserves private media policy through citation serialization', () => {
    const source: SourceMetadata = {
      index: 1,
      url: 'https://example.com',
      title: 'Example',
      toolName: 'search',
      allowRemoteImages: false,
    }
    const citation = sourceToCitation(source)
    expect(citation.allowRemoteImages).toBe(false)
    expect(decodeCitationSources(JSON.stringify([citation]))?.[0].allowRemoteImages).toBe(false)
  })
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
