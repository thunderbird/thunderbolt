import { updateSettings } from '@/dal/settings'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { WeatherForecastData } from '@/widgets/weather-forecast'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import ky, { type KyInstance } from 'ky'
import type { FetchContentParams, SearchLocationParams, SearchParams, WeatherParams } from './tools'
import { fetchContent, getCurrentWeather, getWeatherForecast, search, searchLocations } from './tools'

// Test utilities
const createMockHttpClient = (response: unknown): KyInstance => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return ky.create({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
}

const createErrorHttpClient = (error: Error): KyInstance => {
  const mockFetch = async (): Promise<Response> => {
    throw error
  }

  return ky.create({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
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
    await updateSettings({
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
