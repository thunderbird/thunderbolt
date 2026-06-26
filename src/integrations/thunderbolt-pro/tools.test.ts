/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import type { SourceMetadata } from '@/types/source'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as api from './api'
import type { SearchResultData } from './schemas'
import type { FetchContentParams, SearchParams } from './tools'
import { createConfigs, fetchContent, search } from './tools'

const createMockHttpClient = (response: unknown): HttpClient => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return createClient({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
}

const createErrorHttpClient = (error: Error): HttpClient => {
  const mockFetch = async (): Promise<Response> => {
    throw error
  }

  return createClient({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
}

describe('Thunderbolt Pro Tools', () => {
  describe('search', () => {
    it('should perform web search successfully', async () => {
      const params: SearchParams = {
        query: 'artificial intelligence',
        max_results: 10,
      }

      const mockResponse = {
        results: [
          {
            title: 'AI Article',
            pageUrl: 'https://example.com/ai',
            faviconUrl: 'https://example.com/favicon.ico',
            previewImageUrl: 'https://example.com/image.jpg',
          },
        ],
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await search(params, httpClient)

      expect(result).toEqual(mockResponse.results)
    })

    it('should handle network errors', async () => {
      const params: SearchParams = {
        query: 'test query',
        max_results: 10,
      }

      const httpClient = createErrorHttpClient(new Error('Network timeout'))
      await expect(search(params, httpClient)).rejects.toThrow('Search failed: Network timeout')
    })
  })

  describe('fetchContent', () => {
    it('should fetch webpage content successfully', async () => {
      const params: FetchContentParams = {
        url: 'https://example.com/article',
      }

      const mockResponse = {
        data: {
          url: 'https://example.com/article',
          title: 'Example Article',
          text: 'This is the article content...',
          summary: 'Article summary',
          favicon: 'https://example.com/favicon.ico',
          image: 'https://example.com/image.jpg',
          author: 'John Doe',
          published_date: '2024-01-01T10:00:00Z',
        },
        success: true,
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await fetchContent(params, httpClient)

      expect(result).toEqual(mockResponse.data)
    })

    it('should handle content with null optional fields', async () => {
      const params: FetchContentParams = {
        url: 'https://example.com/simple',
      }

      const mockResponse = {
        data: {
          url: 'https://example.com/simple',
          title: null,
          text: 'Simple content',
          summary: 'Simple summary',
          favicon: null,
          image: null,
          author: null,
          published_date: null,
        },
        success: true,
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await fetchContent(params, httpClient)

      expect(result).toEqual(mockResponse.data)
    })

    it('should handle fetch content failure', async () => {
      const params: FetchContentParams = {
        url: 'https://example.com/invalid',
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'Failed to fetch content',
      }

      const httpClient = createMockHttpClient(mockResponse)
      await expect(fetchContent(params, httpClient)).rejects.toThrow('Failed to fetch content')
    })

    it('should handle network errors', async () => {
      const params: FetchContentParams = {
        url: 'https://example.com/timeout',
      }

      const httpClient = createErrorHttpClient(new Error('Request timeout'))
      await expect(fetchContent(params, httpClient)).rejects.toThrow('Fetch content failed: Request timeout')
    })
  })
})

describe('createConfigs source collector', () => {
  const dummyHttpClient = {} as unknown as HttpClient
  let searchSpy: ReturnType<typeof spyOn>
  let fetchContentSpy: ReturnType<typeof spyOn>

  const mockSearchResults: SearchResultData[] = [
    {
      title: 'Article A',
      pageUrl: 'https://a.com/article',
      faviconUrl: 'https://a.com/favicon.ico',
      previewImageUrl: 'https://a.com/image.jpg',
    },
    {
      title: 'Article B',
      pageUrl: 'https://b.com/article',
      faviconUrl: null,
      previewImageUrl: null,
    },
  ]

  beforeEach(() => {
    searchSpy = spyOn(api, 'search')
    fetchContentSpy = spyOn(api, 'fetchContent')
  })

  afterEach(() => {
    searchSpy.mockRestore()
    fetchContentSpy.mockRestore()
  })

  const getSearchTool = (configs: ReturnType<typeof createConfigs>) => configs.find((c) => c.name === 'search')!
  const getFetchTool = (configs: ReturnType<typeof createConfigs>) => configs.find((c) => c.name === 'fetch_content')!

  it('accumulates sources from search results', async () => {
    searchSpy.mockResolvedValue(mockSearchResults)
    const sourceCollector: SourceMetadata[] = []
    const configs = createConfigs(dummyHttpClient, sourceCollector)

    await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

    expect(sourceCollector).toHaveLength(2)
    expect(sourceCollector[0].index).toBe(1)
    expect(sourceCollector[0].url).toBe('https://a.com/article')
    expect(sourceCollector[0].title).toBe('Article A')
    expect(sourceCollector[0].toolName).toBe('search')
    expect(sourceCollector[1].index).toBe(2)
    expect(sourceCollector[1].url).toBe('https://b.com/article')
  })

  it('deduplicates sources by URL', async () => {
    searchSpy.mockResolvedValue([mockSearchResults[0], mockSearchResults[0]])
    const sourceCollector: SourceMetadata[] = []
    const configs = createConfigs(dummyHttpClient, sourceCollector)

    await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

    expect(sourceCollector).toHaveLength(1)
    expect(sourceCollector[0].index).toBe(1)
  })

  it('continues index from pre-existing sources', async () => {
    searchSpy.mockResolvedValue([mockSearchResults[0]])
    const existingSources: SourceMetadata[] = [
      { index: 1, url: 'https://pre-existing.com', title: 'Pre-existing', toolName: 'search' },
    ]
    const configs = createConfigs(dummyHttpClient, existingSources)

    await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

    expect(existingSources).toHaveLength(2)
    expect(existingSources[1].index).toBe(2)
  })

  it('caps source registry at 200 entries', async () => {
    const bulkResults: SearchResultData[] = Array.from({ length: 10 }, (_, i) => ({
      title: `Site ${i}`,
      pageUrl: `https://site-${i}.com`,
      faviconUrl: null,
      previewImageUrl: null,
    }))
    searchSpy.mockResolvedValue(bulkResults)

    const sourceCollector: SourceMetadata[] = Array.from({ length: 198 }, (_, i) => ({
      index: i + 1,
      url: `https://existing-${i}.com`,
      title: `Existing ${i}`,
      toolName: 'search' as const,
    }))
    const configs = createConfigs(dummyHttpClient, sourceCollector)

    await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

    expect(sourceCollector).toHaveLength(200)
  })

  it('fetch_content creates new source entry', async () => {
    fetchContentSpy.mockResolvedValue({
      url: 'https://example.com/page',
      title: 'Example Page',
      text: 'Page content text here',
      favicon: 'https://example.com/fav.ico',
      image: null,
      author: 'Jane Doe',
      published_date: '2024-06-15',
    })
    const sourceCollector: SourceMetadata[] = []
    const configs = createConfigs(dummyHttpClient, sourceCollector)

    await getFetchTool(configs).execute({ url: 'https://example.com/page' })

    expect(sourceCollector).toHaveLength(1)
    expect(sourceCollector[0].index).toBe(1)
    expect(sourceCollector[0].title).toBe('Example Page')
    expect(sourceCollector[0].toolName).toBe('fetch_content')
  })

  it('fetch_content updates existing source with authoritative data', async () => {
    const sourceCollector: SourceMetadata[] = [
      {
        index: 1,
        url: 'https://example.com/page',
        title: 'https://example.com/page',
        toolName: 'search',
      },
    ]
    fetchContentSpy.mockResolvedValue({
      url: 'https://example.com/page',
      title: 'Real Page Title',
      text: 'Full page content for the article...',
      favicon: 'https://example.com/fav.ico',
      image: 'https://example.com/hero.jpg',
      author: 'Jane Doe',
      published_date: '2024-06-15',
    })
    const configs = createConfigs(dummyHttpClient, sourceCollector)

    await getFetchTool(configs).execute({ url: 'https://example.com/page' })

    expect(sourceCollector).toHaveLength(1)
    expect(sourceCollector[0].title).toBe('Real Page Title')
    expect(sourceCollector[0].description).toBe('Full page content for the article...'.slice(0, 200))
    expect(sourceCollector[0].favicon).toBe('https://example.com/fav.ico')
    expect(sourceCollector[0].image).toBe('https://example.com/hero.jpg')
    expect(sourceCollector[0].author).toBe('Jane Doe')
    expect(sourceCollector[0].publishedDate).toBe('2024-06-15')
  })

  it('assigns consistent indices across search and fetch_content', async () => {
    searchSpy.mockResolvedValue([mockSearchResults[0]])
    fetchContentSpy.mockResolvedValue({
      url: 'https://new-page.com',
      title: 'New Page',
      text: 'Content',
      favicon: null,
      image: null,
      author: null,
      published_date: null,
    })
    const sourceCollector: SourceMetadata[] = []
    const configs = createConfigs(dummyHttpClient, sourceCollector)

    await getSearchTool(configs).execute({ query: 'test', max_results: 10 })
    await getFetchTool(configs).execute({ url: 'https://new-page.com' })

    expect(sourceCollector).toHaveLength(2)
    expect(sourceCollector[0].index).toBe(1)
    expect(sourceCollector[1].index).toBe(2)
  })

  it('works without sourceCollector', async () => {
    searchSpy.mockResolvedValue(mockSearchResults)
    const configs = createConfigs(dummyHttpClient)

    const result = await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

    expect(result).toHaveLength(2)
    expect(result[0].sourceIndex).toBe(1)
    expect(result[1].sourceIndex).toBe(2)
  })
})
