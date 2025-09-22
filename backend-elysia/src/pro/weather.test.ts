import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { SimpleContext } from './context'
import { OpenMeteoWeather } from './weather'

// Mock fetch globally
const mockFetch = spyOn(globalThis, 'fetch')

describe('Pro - OpenMeteoWeather', () => {
  let weather: OpenMeteoWeather
  let mockContext: SimpleContext

  beforeEach(() => {
    weather = new OpenMeteoWeather()
    mockContext = {
      info: spyOn({} as any, 'info').mockResolvedValue(undefined),
      error: spyOn({} as any, 'error').mockResolvedValue(undefined),
    } as any

    mockFetch.mockReset()
  })

  describe('searchLocations', () => {
    it('should search for locations successfully', async () => {
      const mockLocationData = {
        results: [
          {
            name: 'London',
            admin1: 'England',
            country: 'United Kingdom',
            latitude: 51.5074,
            longitude: -0.1278,
            elevation: 25,
          },
          {
            name: 'London',
            admin1: 'Ontario',
            country: 'Canada',
            latitude: 42.9849,
            longitude: -81.2453,
            elevation: 251,
          },
        ],
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      const results = await weather.searchLocations('London', mockContext)

      expect(results).toEqual(mockLocationData.results)
      expect(mockContext.info).toHaveBeenCalledWith('Searching locations for: London')
      expect(mockContext.info).toHaveBeenCalledWith('Found 2 locations')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://geocoding-api.open-meteo.com/v1/search?name=London&count=10&language=en&format=json',
      )
    })

    it('should handle empty results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response)

      const results = await weather.searchLocations('NonexistentPlace', mockContext)

      expect(results).toEqual([])
      expect(mockContext.info).toHaveBeenCalledWith('Found 0 locations')
    })

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      } as Response)

      await expect(weather.searchLocations('Invalid', mockContext)).rejects.toThrow('Geocoding API error: 400')
      expect(mockContext.error).toHaveBeenCalled() // Don't check exact message
    })

    it('should handle network errors', async () => {
      const networkError = new Error('Network failure')
      mockFetch.mockRejectedValueOnce(networkError)

      await expect(weather.searchLocations('London', mockContext)).rejects.toThrow('Network failure')
      expect(mockContext.error).toHaveBeenCalled() // Don't check exact message
    })

    it('should construct correct URL with query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response)

      await weather.searchLocations('New York', mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://geocoding-api.open-meteo.com/v1/search?name=New+York&count=10&language=en&format=json',
      )
    })
  })

  describe('getCurrentWeather', () => {
    const mockLocationData = {
      results: [
        {
          name: 'London',
          admin1: 'England',
          country: 'United Kingdom',
          latitude: 51.5074,
          longitude: -0.1278,
        },
      ],
    }

    const mockWeatherData = {
      current: {
        temperature_2m: 15.2,
        relative_humidity_2m: 65,
        apparent_temperature: 14.5,
        weather_code: 1,
        wind_speed_10m: 12.5,
        wind_direction_10m: 180,
        time: '2024-01-15T15:00',
      },
      current_units: {
        temperature_2m: '°C',
        relative_humidity_2m: '%',
        apparent_temperature: '°C',
        weather_code: 'wmo code',
        wind_speed_10m: 'km/h',
        wind_direction_10m: '°',
      },
    }

    it('should get current weather successfully', async () => {
      // Mock location search
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      // Mock weather data
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockWeatherData,
      } as Response)

      const result = await weather.getCurrentWeather('London', mockContext)

      expect(result).toContain('Current weather for London, England, United Kingdom:')
      expect(result).toContain('Temperature: 15.2°C')
      expect(result).toContain('Feels like: 14.5°C')
      expect(result).toContain('Humidity: 65%')
      expect(result).toContain('Wind: 12.5km/h at 180°')
      expect(result).toContain('Weather code: 1')
      expect(result).toContain('Last updated: 2024-01-15T15:00')

      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Check weather API call
      const weatherCall = mockFetch.mock.calls[1][0] as string
      expect(weatherCall).toContain('https://api.open-meteo.com/v1/forecast')
      expect(weatherCall).toContain('latitude=51.5074')
      expect(weatherCall).toContain('longitude=-0.1278')
      expect(weatherCall).toContain('current=temperature_2m')
      expect(weatherCall).toContain('timezone=auto')
    })

    it('should handle location not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response)

      const result = await weather.getCurrentWeather('NonexistentPlace', mockContext)

      expect(result).toBe('No location found matching: NonexistentPlace')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should handle weather API errors', async () => {
      // Mock successful location search
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      // Mock weather API error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response)

      await expect(weather.getCurrentWeather('London', mockContext)).rejects.toThrow('Weather API error: 500')
      expect(mockContext.error).toHaveBeenCalled() // Don't check exact message
    })

    it('should handle location with minimal data', async () => {
      const minimalLocation = {
        results: [
          {
            name: 'TestCity',
            latitude: 40.0,
            longitude: -74.0,
          },
        ],
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => minimalLocation,
      } as Response)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockWeatherData,
      } as Response)

      const result = await weather.getCurrentWeather('TestCity', mockContext)

      expect(result).toContain('Current weather for TestCity:')
    })
  })

  describe('getWeatherForecast', () => {
    const mockLocationData = {
      results: [
        {
          name: 'London',
          admin1: 'England',
          country: 'United Kingdom',
          latitude: 51.5074,
          longitude: -0.1278,
        },
      ],
    }

    const mockForecastData = {
      daily: {
        time: ['2024-01-15', '2024-01-16', '2024-01-17'],
        temperature_2m_max: [18.5, 20.1, 16.8],
        temperature_2m_min: [10.2, 12.5, 8.9],
        weather_code: [1, 2, 3],
        precipitation_sum: [0.0, 2.5, 5.1],
        wind_speed_10m_max: [15.2, 18.7, 22.1],
      },
      daily_units: {
        temperature_2m_max: '°C',
        temperature_2m_min: '°C',
        precipitation_sum: 'mm',
        wind_speed_10m_max: 'km/h',
      },
    }

    it('should get weather forecast successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockForecastData,
      } as Response)

      const result = await weather.getWeatherForecast('London', 3, mockContext)

      expect(result).toContain('3-day weather forecast for London, England, United Kingdom:')
      expect(result).toContain('1/15/2024:')
      expect(result).toContain('High: 18.5°C')
      expect(result).toContain('Low: 10.2°C')
      expect(result).toContain('Precipitation: 0mm')
      expect(result).toContain('Max wind: 15.2km/h')
      expect(result).toContain('Weather code: 1')

      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Check forecast API call
      const forecastCall = mockFetch.mock.calls[1][0] as string
      expect(forecastCall).toContain('daily=temperature_2m_max')
      expect(forecastCall).toContain('forecast_days=3')
    })

    it('should handle different forecast days', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockForecastData,
          daily: {
            ...mockForecastData.daily,
            time: ['2024-01-15'],
            temperature_2m_max: [18.5],
            temperature_2m_min: [10.2],
            weather_code: [1],
            precipitation_sum: [0.0],
            wind_speed_10m_max: [15.2],
          },
        }),
      } as Response)

      const result = await weather.getWeatherForecast('London', 1, mockContext)

      expect(result).toContain('1-day weather forecast')
      expect(mockContext.info).toHaveBeenCalledWith('Getting 1-day forecast for: London')

      const forecastCall = mockFetch.mock.calls[1][0] as string
      expect(forecastCall).toContain('forecast_days=1')
    })

    it('should handle location not found for forecast', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response)

      const result = await weather.getWeatherForecast('NonexistentPlace', 3, mockContext)

      expect(result).toBe('No location found matching: NonexistentPlace')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should handle forecast API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response)

      await expect(weather.getWeatherForecast('London', 3, mockContext)).rejects.toThrow('Weather API error: 500')
      expect(mockContext.error).toHaveBeenCalled() // Don't check exact message
    })

    it('should format dates correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockForecastData,
      } as Response)

      const result = await weather.getWeatherForecast('London', 3, mockContext)

      // Check that dates are formatted as expected
      expect(result).toContain('1/15/2024:')
      expect(result).toContain('1/16/2024:')
      expect(result).toContain('1/17/2024:')
    })

    it('should handle missing forecast data gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      const emptyForecast = {
        daily: {
          time: [],
          temperature_2m_max: [],
          temperature_2m_min: [],
          weather_code: [],
          precipitation_sum: [],
          wind_speed_10m_max: [],
        },
        daily_units: {},
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => emptyForecast,
      } as Response)

      const result = await weather.getWeatherForecast('London', 3, mockContext)

      expect(result).toContain('3-day weather forecast for London, England, United Kingdom:')
      // Should not crash with empty data
    })
  })
})
