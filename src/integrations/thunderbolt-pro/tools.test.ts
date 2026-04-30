/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal/settings'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createClient, type HttpClient } from '@/lib/http'
import type { SourceMetadata } from '@/types/source'
import type { WeatherForecastData } from '@/widgets/weather-forecast'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as api from './api'
import type { SearchResultData } from './schemas'
import type { FetchContentParams, SearchLocationParams, SearchParams, WeatherParams } from './tools'
import { createConfigs, fetchContent, getCurrentWeather, getWeatherForecast, search, searchLocations } from './tools'

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

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

// Mock weather forecast schema
const mockWeatherForecastData: WeatherForecastData = {
  location: 'New York',
  days: [
    {
      date: '2024-01-01',
      weather_code: 0,
      temperature_max: 25,
      temperature_min: 15,
      apparent_temperature_max: 27,
      apparent_temperature_min: 13,
      precipitation_sum: 0,
      precipitation_probability_max: 0,
      wind_speed_10m_max: 10,
    },
    {
      date: '2024-01-02',
      weather_code: 1,
      temperature_max: 22,
      temperature_min: 12,
      apparent_temperature_max: 24,
      apparent_temperature_min: 10,
      precipitation_sum: 2.5,
      precipitation_probability_max: 80,
      wind_speed_10m_max: 15,
    },
  ],
  temperature_unit: 'f',
}

describe('Thunderbolt Pro Tools', () => {
  beforeEach(async () => {
    // Set up test database with correct values
    await updateSettings(getDb(), {
      cloud_url: 'http://localhost:8000/v1',
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })
  })

  describe('search', () => {
    it('should perform web search successfully', async () => {
      const params: SearchParams = {
        query: 'artificial intelligence',
        max_results: 10,
      }

      const mockResponse = {
        data: [
          {
            url: 'https://example.com/ai',
            title: 'AI Article',
            favicon: 'https://example.com/favicon.ico',
            image: 'https://example.com/image.jpg',
            author: 'John Doe',
            publishedDate: '2024-01-01',
            id: '1',
          },
        ],
        success: true,
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await search(params, httpClient)

      expect(result).toEqual(mockResponse.data)
    })

    it('should handle search failure', async () => {
      const params: SearchParams = {
        query: 'test query',
        max_results: 10,
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'Search service unavailable',
      }

      const httpClient = createMockHttpClient(mockResponse)
      await expect(search(params, httpClient)).rejects.toThrow('Search service unavailable')
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

  describe('getCurrentWeather', () => {
    it('should get current weather successfully', async () => {
      const params: WeatherParams = {
        location: 'New York',
        region: 'NY',
        country: 'US',
        days: 1,
      }

      const mockResponse = {
        data: 'Current weather in New York: 22°C, Partly cloudy',
        success: true,
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await getCurrentWeather(params, httpClient)

      expect(result).toBe('Current weather in New York: 22°C, Partly cloudy')
    })

    it('should handle weather request failure', async () => {
      const params: WeatherParams = {
        location: 'InvalidCity',
        region: 'XX',
        country: 'XX',
        days: 1,
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'Location not found',
      }

      const httpClient = createMockHttpClient(mockResponse)
      await expect(getCurrentWeather(params, httpClient)).rejects.toThrow('Location not found')
    })
  })

  describe('getWeatherForecast', () => {
    it('should get weather forecast successfully', async () => {
      const params: WeatherParams = {
        location: 'New York',
        region: 'NY',
        country: 'US',
        days: 3,
      }

      const mockResponse = {
        data: mockWeatherForecastData,
        success: true,
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await getWeatherForecast(params, httpClient)

      expect(result).toEqual(mockWeatherForecastData)
      expect(result.days).toHaveLength(2)
      expect(result.temperature_unit).toBe('f')
    })

    it('should handle weather forecast failure', async () => {
      const params: WeatherParams = {
        location: 'InvalidCity',
        region: 'XX',
        country: 'XX',
        days: 3,
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'Forecast unavailable',
      }

      const httpClient = createMockHttpClient(mockResponse)
      await expect(getWeatherForecast(params, httpClient)).rejects.toThrow('Forecast unavailable')
    })
  })

  describe('searchLocations', () => {
    it('should search locations successfully', async () => {
      const params: SearchLocationParams = {
        query: 'New York',
        region: 'NY',
        country: 'US',
      }

      const mockResponse = {
        data: 'Location: New York, NY, US (coordinates: 40.7128, -74.0060)',
        success: true,
      }

      const httpClient = createMockHttpClient(mockResponse)
      const result = await searchLocations(params, httpClient)

      expect(result).toBe('Location: New York, NY, US (coordinates: 40.7128, -74.0060)')
    })

    it('should handle location search failure', async () => {
      const params: SearchLocationParams = {
        query: 'InvalidPlace',
        region: 'XX',
        country: 'XX',
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'No locations found',
      }

      const httpClient = createMockHttpClient(mockResponse)
      await expect(searchLocations(params, httpClient)).rejects.toThrow('No locations found')
    })
  })
})

describe('createConfigs source collector', () => {
  const dummyHttpClient = {} as unknown as HttpClient
  let searchSpy: ReturnType<typeof spyOn>
  let fetchContentSpy: ReturnType<typeof spyOn>

  const mockSearchResults: SearchResultData[] = [
    {
      id: 'r1',
      url: 'https://a.com/article',
      title: 'Article A',
      summary: 'Summary A',
      favicon: 'https://a.com/favicon.ico',
      image: 'https://a.com/image.jpg',
      author: 'Author A',
      publishedDate: '2024-01-01',
    },
    {
      id: 'r2',
      url: 'https://b.com/article',
      title: 'Article B',
      summary: 'Summary B',
      favicon: null,
      image: null,
      author: null,
      publishedDate: null,
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
      id: `bulk-${i}`,
      url: `https://site-${i}.com`,
      title: `Site ${i}`,
      favicon: null,
      image: null,
      author: null,
      publishedDate: null,
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
