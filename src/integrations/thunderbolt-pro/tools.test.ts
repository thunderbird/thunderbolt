/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { loadCalibrationFixtures } from '@/ai/eval/fixtures'
import { createToolset } from '@/lib/tools'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import { createClient, type HttpClient } from '@/lib/http'
import type { SourceMetadata } from '@/types/source'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as api from './api'
import type { SearchResultData } from './schemas'
import type { FetchContentParams, SearchParams } from './tools'
import { createConfigs, fetchContent, search } from './tools'
import { createTinfoilWebApi } from '@/integrations/tinfoil-search/api'

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
          publishedDate: '2024-01-01T10:00:00Z',
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
          publishedDate: null,
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

  it('keeps the Tinfoil passive-image restriction when sources are collected, reused, and enriched', async () => {
    const pageUrl = 'https://example.com/private-search'
    const sources: SourceMetadata[] = [
      {
        index: 1,
        url: pageUrl,
        title: 'Existing public source',
        toolName: 'search',
      },
    ]
    const webApi = createTinfoilWebApi(
      async () => 'unused',
      async (name) => ({
        structuredContent:
          name === 'search'
            ? {
                results: [
                  {
                    title: 'Private source',
                    url: pageUrl,
                    content: 'Search snippet',
                    favicon: 'https://example.com/icon',
                  },
                  { title: 'New source', url: 'https://example.org', content: 'Another snippet' },
                ],
              }
            : { pages: [{ url: pageUrl, content: 'Full page content' }] },
      }),
    )
    const configs = createConfigs(dummyHttpClient, sources, webApi)
    await configs[0].execute({ query: 'sensitive search' })
    expect(sources).toHaveLength(2)
    expect(sources.every((source) => source.allowRemoteImages === false)).toBe(true)
    await configs[1].execute({ url: pageUrl })
    expect(sources[0].description).toBe('Full page content')
    expect(sources[0].allowRemoteImages).toBe(false)
  })

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

  it('preserves existing citations at the cap and cites excess search results by URL', async () => {
    const sourceCollector: SourceMetadata[] = Array.from({ length: 200 }, (_, i) => ({
      index: i + 1,
      url: `https://existing-${i}.com`,
      title: `Existing ${i}`,
      toolName: 'search',
    }))
    searchSpy.mockResolvedValue([
      { ...mockSearchResults[0], pageUrl: sourceCollector[7].url },
      { ...mockSearchResults[1], sourceIndex: 999 },
    ])
    const configs = createConfigs(dummyHttpClient, sourceCollector)
    const result = await getSearchTool(configs).execute({ query: 'test', max_results: 2 })
    expect(result[0]).toMatchObject({ sourceIndex: 8, sourceLabel: '[Source 8] (cite as [8])' })
    expect(result[1].sourceIndex).toBeUndefined()
    expect(result[1]).toMatchObject({
      pageUrl: mockSearchResults[1].pageUrl,
      sourceLabel: 'Cite this source using its URL.',
    })
    expect(sourceCollector).toHaveLength(200)
  })

  it('preserves existing citations at the cap and cites excess fetched pages by URL', async () => {
    const sourceCollector: SourceMetadata[] = Array.from({ length: 200 }, (_, i) => ({
      index: i + 1,
      url: `https://existing-${i}.com`,
      title: `Existing ${i}`,
      toolName: 'search',
    }))
    const page = { title: 'Authoritative title', text: 'Evidence', favicon: null, image: null, author: null }
    fetchContentSpy.mockResolvedValueOnce({ ...page, url: sourceCollector[7].url })
    fetchContentSpy.mockResolvedValueOnce({ ...page, url: 'https://new-page.com', sourceIndex: 999 })
    const configs = createConfigs(dummyHttpClient, sourceCollector)
    expect(await getFetchTool(configs).execute({ url: sourceCollector[7].url })).toMatchObject({
      sourceIndex: 8,
      sourceLabel: '[Source 8] (cite as [8])',
    })
    expect(sourceCollector[7].title).toBe('Authoritative title')
    const overflow = await getFetchTool(configs).execute({ url: 'https://new-page.com' })
    expect(overflow.sourceIndex).toBeUndefined()
    expect(overflow).toMatchObject({
      url: 'https://new-page.com',
      text: 'Evidence',
      sourceLabel: 'Cite this source using its URL.',
    })
    expect(sourceCollector).toHaveLength(200)
  })

  it('allocates from the live collector when tool configs share one logical turn', async () => {
    const sources: SourceMetadata[] = []
    const first = createConfigs(dummyHttpClient, sources)
    const second = createConfigs(dummyHttpClient, sources)
    searchSpy.mockResolvedValueOnce([mockSearchResults[0]])
    searchSpy.mockResolvedValueOnce([mockSearchResults[1]])
    await getSearchTool(first).execute({ query: 'first', max_results: 1 })
    expect(await getSearchTool(second).execute({ query: 'second', max_results: 1 })).toMatchObject([{ sourceIndex: 2 }])
    expect(sources.map(({ index }) => index)).toEqual([1, 2])
  })

  it('fetch_content creates new source entry', async () => {
    fetchContentSpy.mockResolvedValue({
      url: 'https://example.com/page',
      title: 'Example Page',
      text: 'Page content text here',
      favicon: 'https://example.com/fav.ico',
      image: null,
      author: 'Jane Doe',
      publishedDate: '2024-06-15',
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
      publishedDate: '2024-06-15',
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
      publishedDate: null,
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

  it('keeps our citation indices authoritative when an upstream includes its own indices', async () => {
    searchSpy.mockResolvedValue([{ ...mockSearchResults[0], sourceIndex: 99 }])
    fetchContentSpy.mockResolvedValue({
      url: mockSearchResults[0].pageUrl,
      title: 'Page',
      text: 'Evidence',
      favicon: null,
      image: null,
      author: null,
      sourceIndex: 77,
    })
    const sources: SourceMetadata[] = []
    const configs = createConfigs(dummyHttpClient, sources)
    expect(await getSearchTool(configs).execute({ query: 'test', max_results: 1 })).toMatchObject([
      { sourceIndex: 1, sourceLabel: '[Source 1] (cite as [1])' },
    ])
    expect(await getFetchTool(configs).execute({ url: mockSearchResults[0].pageUrl })).toMatchObject({
      sourceIndex: 1,
      sourceLabel: '[Source 1] (cite as [1])',
    })
    expect(sources).toHaveLength(1)
    expect(sources[0].index).toBe(1)
  })

  describe('prior turns', () => {
    const priorSources: SourceMetadata[] = [
      { index: 1, url: 'https://earlier.com/one', title: 'Earlier 1', toolName: 'search' },
      { index: 2, url: 'https://earlier.com/two', title: 'Earlier 2', toolName: 'search' },
      { index: 3, url: 'https://a.com/article', title: 'Earlier A', toolName: 'search' },
    ]

    it('continues numbering after the sources earlier turns registered', async () => {
      searchSpy.mockResolvedValue([mockSearchResults[1]])
      const sourceCollector: SourceMetadata[] = []
      const configs = createConfigs(dummyHttpClient, sourceCollector, undefined, priorSources)

      const result = await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

      expect(result[0].sourceIndex).toBe(4)
      expect(result[0].sourceLabel).toBe('[Source 4] (cite as [4])')
      expect(sourceCollector).toEqual([expect.objectContaining({ index: 4, url: 'https://b.com/article' })])
    })

    it('keeps the number an earlier turn gave a URL and records it under that number', async () => {
      searchSpy.mockResolvedValue(mockSearchResults)
      const sourceCollector: SourceMetadata[] = []
      const configs = createConfigs(dummyHttpClient, sourceCollector, undefined, priorSources)

      const result = await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

      expect(result[0].sourceIndex).toBe(3)
      expect(result[1].sourceIndex).toBe(4)
      expect(sourceCollector.map((s) => [s.index, s.url])).toEqual([
        [3, 'https://a.com/article'],
        [4, 'https://b.com/article'],
      ])
    })

    it('numbers after the highest index when earlier turns are not contiguous', async () => {
      searchSpy.mockResolvedValue([mockSearchResults[1]])
      const sparse: SourceMetadata[] = [
        { index: 1, url: 'https://x.com', title: 'X', toolName: 'search' },
        { index: 7, url: 'https://y.com', title: 'Y', toolName: 'search' },
      ]
      const configs = createConfigs(dummyHttpClient, [], undefined, sparse)

      const result = await getSearchTool(configs).execute({ query: 'test', max_results: 10 })

      expect(result[0].sourceIndex).toBe(8)
    })

    it('fetch_content reuses an earlier turn’s number without mutating that turn’s entry', async () => {
      fetchContentSpy.mockResolvedValue({
        url: 'https://earlier.com/two',
        title: 'Fresh Title',
        text: 'Body',
        favicon: null,
        image: null,
        author: null,
        publishedDate: null,
      })
      const sourceCollector: SourceMetadata[] = []
      const configs = createConfigs(dummyHttpClient, sourceCollector, undefined, priorSources)

      const result = await getFetchTool(configs).execute({ url: 'https://earlier.com/two' })

      expect(result.sourceIndex).toBe(2)
      expect(priorSources[1].title).toBe('Earlier 2')
      expect(sourceCollector).toEqual([expect.objectContaining({ index: 2, title: 'Fresh Title' })])
    })
  })
})

it('passes search snippets and canonical publication dates from the API to model results and sources', async () => {
  const sourceCollector: SourceMetadata[] = []
  const client = createMockHttpClient({
    results: [
      {
        title: 'Article',
        pageUrl: 'https://source.test/article',
        faviconUrl: null,
        previewImageUrl: null,
        snippet: 'Supported fact.',
        publishedDate: '2026-09-01',
      },
    ],
  })
  const config = createConfigs(client, sourceCollector).find(({ name }) => name === 'search')!
  const result = await config.execute({ query: 'query', max_results: 1 })
  expect(result).toMatchObject([{ sourceIndex: 1, snippet: 'Supported fact.', publishedDate: '2026-09-01' }])
  expect(sourceCollector).toMatchObject([{ index: 1, description: 'Supported fact.', publishedDate: '2026-09-01' }])
})

it('surfaces a failed fetch as a Pi tool failure without registering a source', async () => {
  const sources: SourceMetadata[] = []
  const client = createMockHttpClient({
    success: false,
    data: null,
    error: 'Source did not load or returned no usable text.',
  })
  const tools = await toPiAgentTools(createToolset(createConfigs(client, sources)))
  const fetchTool = tools.find(({ name }) => name === 'fetch_content')!
  await expect(fetchTool.execute('fetch-1', { url: 'https://source.test' })).rejects.toThrow('Source did not load')
  expect(sources).toEqual([])
})

it('passes the technical-404 negative-control fixture through as model content', async () => {
  const fixture = loadCalibrationFixtures().find(({ id }) => id === 'valid-technical-page-about-404')!
  const evidence = fixture.conversation[0].evidence[0]
  const sources: SourceMetadata[] = []
  const tools = await toPiAgentTools(
    createToolset(createConfigs(createMockHttpClient({ success: true, data: evidence }), sources)),
  )
  const fetchTool = tools.find(({ name }) => name === 'fetch_content')!
  const result = await fetchTool.execute('fetch-1', { url: evidence.url })
  expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(evidence.text) }])
  expect(sources).toMatchObject([{ index: 1, url: evidence.url }])
})
