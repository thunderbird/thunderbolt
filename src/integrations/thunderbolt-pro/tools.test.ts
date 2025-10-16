import type { WeatherForecastData } from '@/lib/weather-forecast'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { FetchContentParams, SearchLocationParams, SearchParams, WeatherParams } from './tools'
import { fetchContent, getCurrentWeather, getWeatherForecast, search, searchLocations } from './tools'

// Mock external dependencies
const mockGet = mock()
const mockPost = mock()
const mockJson = mock()
const mockGetCloudUrl = mock()

// Mock ky
mock.module('ky', () => ({
  default: {
    get: mockGet,
    post: mockPost,
  },
}))

// Mock config
mock.module('@/lib/config', () => ({
  getCloudUrl: mockGetCloudUrl,
}))

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
  beforeEach(() => {
    // Reset all mocks
    mockGet.mockClear()
    mockPost.mockClear()
    mockJson.mockClear()
    mockGetCloudUrl.mockClear()

    // Setup default mocks
    mockGetCloudUrl.mockResolvedValue('https://example.com')
    mockPost.mockReturnValue({ json: mockJson })
  })

  describe('search', () => {
    it('should perform web search successfully', async () => {
      const params: SearchParams = {
        query: 'artificial intelligence',
        max_results: 10,
      }

      const mockResponse = {
        data: 'Search results for artificial intelligence...',
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      const result = await search(params)

      expect(result).toBe('Search results for artificial intelligence...')
      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/search',
        expect.objectContaining({
          timeout: 5000,
          json: {
            query: 'artificial intelligence',
            max_results: 10,
          },
        }),
      )
    })

    it('should use default max_results when not provided', async () => {
      const params: SearchParams = {
        query: 'test query',
        max_results: 5,
      }

      const mockResponse = {
        data: 'Search results...',
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      await search(params)

      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/search',
        expect.objectContaining({
          json: {
            query: 'test query',
            max_results: 5,
          },
        }),
      )
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

      mockJson.mockResolvedValue(mockResponse)

      await expect(search(params)).rejects.toThrow('Search service unavailable')
    })

    it('should handle network errors', async () => {
      const params: SearchParams = {
        query: 'test query',
        max_results: 10,
      }

      const networkError = new Error('Network timeout')
      mockPost.mockImplementation(() => {
        throw networkError
      })

      await expect(search(params)).rejects.toThrow('Search failed: Network timeout')
    })

    it('should handle unknown errors', async () => {
      const params: SearchParams = {
        query: 'test query',
        max_results: 10,
      }

      mockPost.mockImplementation(() => {
        throw 'Unknown error'
      })

      await expect(search(params)).rejects.toThrow('Search failed: Unknown error')
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
          favicon: 'https://example.com/favicon.ico',
          image: 'https://example.com/image.jpg',
          author: 'John Doe',
          published_date: '2024-01-01T10:00:00Z',
        },
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      const result = await fetchContent(params)

      expect(result).toEqual({
        url: 'https://example.com/article',
        title: 'Example Article',
        text: 'This is the article content...',
        favicon: 'https://example.com/favicon.ico',
        image: 'https://example.com/image.jpg',
        author: 'John Doe',
        published_date: '2024-01-01T10:00:00Z',
      })

      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/fetch-content',
        expect.objectContaining({
          timeout: 5000,
          json: {
            url: 'https://example.com/article',
          },
        }),
      )
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
          favicon: null,
          image: null,
          author: null,
          published_date: null,
        },
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      const result = await fetchContent(params)

      expect(result).toEqual({
        url: 'https://example.com/simple',
        title: null,
        text: 'Simple content',
        favicon: null,
        image: null,
        author: null,
        published_date: null,
      })
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

      mockJson.mockResolvedValue(mockResponse)

      await expect(fetchContent(params)).rejects.toThrow('Failed to fetch content')
    })

    it('should handle network errors', async () => {
      const params: FetchContentParams = {
        url: 'https://example.com/timeout',
      }

      const networkError = new Error('Request timeout')
      mockPost.mockImplementation(() => {
        throw networkError
      })

      await expect(fetchContent(params)).rejects.toThrow('Fetch content failed: Request timeout')
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

      mockJson.mockResolvedValue(mockResponse)

      const result = await getCurrentWeather(params)

      expect(result).toBe('Current weather in New York: 22°C, Partly cloudy')
      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/weather/current',
        expect.objectContaining({
          timeout: 5000,
          json: {
            location: 'New York',
            region: 'NY',
            country: 'US',
            distanceUnit: 'imperial',
            temperatureUnit: 'f',
          },
        }),
      )
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

      mockJson.mockResolvedValue(mockResponse)

      await expect(getCurrentWeather(params)).rejects.toThrow('Location not found')
    })

    it('should handle network errors', async () => {
      const params: WeatherParams = {
        location: 'New York',
        region: 'NY',
        country: 'US',
        days: 1,
      }

      const networkError = new Error('Weather service unavailable')
      mockPost.mockImplementation(() => {
        throw networkError
      })

      await expect(getCurrentWeather(params)).rejects.toThrow('Weather request failed: Weather service unavailable')
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

      mockJson.mockResolvedValue(mockResponse)

      const result = await getWeatherForecast(params)

      expect(result).toEqual(mockWeatherForecastData)
      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/weather/forecast',
        expect.objectContaining({
          timeout: 5000,
          json: {
            location: 'New York',
            region: 'NY',
            country: 'US',
            days: 3,
            distanceUnit: 'imperial',
            temperatureUnit: 'f',
          },
        }),
      )
    })

    it('should use default days when not provided', async () => {
      const params: WeatherParams = {
        location: 'New York',
        region: 'NY',
        country: 'US',
        days: 5,
      }

      const mockResponse = {
        data: mockWeatherForecastData,
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      await getWeatherForecast(params)

      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/weather/forecast',
        expect.objectContaining({
          json: {
            location: 'New York',
            region: 'NY',
            country: 'US',
            days: 5,
            distanceUnit: 'imperial',
            temperatureUnit: 'f',
          },
        }),
      )
    })

    it('should handle forecast request failure', async () => {
      const params: WeatherParams = {
        location: 'InvalidCity',
        region: 'XX',
        country: 'XX',
        days: 3,
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'Forecast not available',
      }

      mockJson.mockResolvedValue(mockResponse)

      await expect(getWeatherForecast(params)).rejects.toThrow('Forecast not available')
    })

    it('should handle invalid forecast data', async () => {
      const params: WeatherParams = {
        location: 'New York',
        region: 'NY',
        country: 'US',
        days: 3,
      }

      const mockResponse = {
        data: { invalid: 'data' },
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      await expect(getWeatherForecast(params)).rejects.toThrow()
    })

    it('should handle network errors', async () => {
      const params: WeatherParams = {
        location: 'New York',
        region: 'NY',
        country: 'US',
        days: 3,
      }

      const networkError = new Error('Forecast service unavailable')
      mockPost.mockImplementation(() => {
        throw networkError
      })

      await expect(getWeatherForecast(params)).rejects.toThrow(
        'Weather forecast request failed: Forecast service unavailable',
      )
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
        data: 'Found locations: New York, NY, US',
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      const result = await searchLocations(params)

      expect(result).toBe('Found locations: New York, NY, US')
      expect(mockPost).toHaveBeenCalledWith(
        'https://example.com/pro/locations/search',
        expect.objectContaining({
          timeout: 5000,
          json: {
            query: 'New York',
            region: 'NY',
            country: 'US',
            distanceUnit: 'imperial',
            temperatureUnit: 'f',
          },
        }),
      )
    })

    it('should handle location search failure', async () => {
      const params: SearchLocationParams = {
        query: 'NonexistentCity',
        region: 'XX',
        country: 'XX',
      }

      const mockResponse = {
        data: null,
        success: false,
        error: 'No locations found',
      }

      mockJson.mockResolvedValue(mockResponse)

      await expect(searchLocations(params)).rejects.toThrow('No locations found')
    })

    it('should handle network errors', async () => {
      const params: SearchLocationParams = {
        query: 'New York',
        region: 'NY',
        country: 'US',
      }

      const networkError = new Error('Location service unavailable')
      mockPost.mockImplementation(() => {
        throw networkError
      })

      await expect(searchLocations(params)).rejects.toThrow('Location search failed: Location service unavailable')
    })
  })

  describe('error handling and edge cases', () => {
    it('should handle cloud URL fetch failure', async () => {
      const params: SearchParams = {
        query: 'test',
        max_results: 10,
      }

      mockGetCloudUrl.mockRejectedValue(new Error('Config service unavailable'))

      await expect(search(params)).rejects.toThrow('Config service unavailable')
    })

    it('should handle malformed JSON responses', async () => {
      const params: SearchParams = {
        query: 'test',
        max_results: 10,
      }

      mockJson.mockResolvedValue('invalid json')

      await expect(search(params)).rejects.toThrow()
    })

    it('should handle timeout errors', async () => {
      const params: SearchParams = {
        query: 'test',
        max_results: 10,
      }

      const timeoutError = new Error('Request timeout')
      mockPost.mockImplementation(() => {
        throw timeoutError
      })

      await expect(search(params)).rejects.toThrow('Search failed: Request timeout')
    })

    it('should handle empty response data', async () => {
      const params: SearchParams = {
        query: 'test',
        max_results: 10,
      }

      const mockResponse = {
        data: '',
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      const result = await search(params)
      expect(result).toBe('')
    })

    it('should handle very large responses', async () => {
      const params: SearchParams = {
        query: 'test',
        max_results: 100,
      }

      const largeData = 'x'.repeat(100000)
      const mockResponse = {
        data: largeData,
        success: true,
      }

      mockJson.mockResolvedValue(mockResponse)

      const result = await search(params)
      expect(result).toBe(largeData)
    })
  })
})
