/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { OpenMeteoWeather } from './weather'

describe('Pro - OpenMeteoWeather', () => {
  let weather: OpenMeteoWeather
  let mockFetch: ReturnType<typeof mock>

  beforeEach(() => {
    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(new Response()))
    weather = new OpenMeteoWeather(mockFetch as unknown as typeof fetch)
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

      const results = await weather.searchLocations('London', 'England', 'United Kingdom')

      expect(results).toEqual([mockLocationData.results[0]]) // Should only return London, England

      expect(mockFetch).toHaveBeenCalledWith(
        'https://geocoding-api.open-meteo.com/v1/search?name=London&count=10&language=en&format=json',
      )
    })

    it('should handle empty results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response)

      const results = await weather.searchLocations('NonexistentPlace', '', '')

      expect(results).toEqual([])
    })

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      } as Response)

      await expect(weather.searchLocations('Invalid', '', '')).rejects.toThrow('Geocoding API error: 400')
    })

    it('should handle network errors', async () => {
      const networkError = new Error('Network failure')
      mockFetch.mockRejectedValueOnce(networkError)

      await expect(weather.searchLocations('London', 'England', 'United Kingdom')).rejects.toThrow('Network failure')
    })

    it('should construct correct URL with query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response)

      await weather.searchLocations('New York', 'NY', 'United States')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://geocoding-api.open-meteo.com/v1/search?name=New+York&count=10&language=en&format=json',
      )
    })

    describe('disambiguateLocation', () => {
      const mockLocations = [
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
        {
          name: 'London',
          admin1: 'Kentucky',
          country: 'United States',
          latitude: 37.1289,
          longitude: -84.0833,
          elevation: 300,
        },
        {
          name: 'Paris',
          admin1: 'Île-de-France',
          country: 'France',
          latitude: 48.8566,
          longitude: 2.3522,
          elevation: 35,
        },
        {
          name: 'Paris',
          admin1: 'Texas',
          country: 'United States',
          latitude: 33.6609,
          longitude: -95.5555,
          elevation: 180,
        },
      ]

      it('should filter by region when provided', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', 'England', null)

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('England')
        expect(results[0].country).toBe('United Kingdom')
      })

      it('should filter by country when provided', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', null, 'Canada')

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('Ontario')
        expect(results[0].country).toBe('Canada')
      })

      it('should filter by both region and country when provided', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', 'England', 'United Kingdom')

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('England')
        expect(results[0].country).toBe('United Kingdom')
      })

      it('should return all locations when no region or country provided', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', null, null)

        expect(results).toHaveLength(5) // All locations (London and Paris)
        expect(results.every((loc) => loc.name === 'London' || loc.name === 'Paris')).toBe(true)
      })

      it('should handle case-insensitive region matching', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', 'ENGLAND', null)

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('England')
      })

      it('should handle case-insensitive country matching', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', null, 'CANADA')

        expect(results).toHaveLength(1)
        expect(results[0].country).toBe('Canada')
      })

      it('should handle partial region matching', async () => {
        const locationsWithPartialMatch = [
          {
            name: 'Springfield',
            admin1: 'Massachusetts',
            country: 'United States',
            latitude: 42.1015,
            longitude: -72.5898,
          },
          {
            name: 'Springfield',
            admin1: 'Missouri',
            country: 'United States',
            latitude: 37.2083,
            longitude: -93.2923,
          },
        ]

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: locationsWithPartialMatch }),
        } as Response)

        const results = await weather.searchLocations('Springfield', 'Mass', null)

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('Massachusetts')
      })

      it('should handle partial country matching', async () => {
        const locationsWithPartialMatch = [
          {
            name: 'Manchester',
            admin1: 'England',
            country: 'United Kingdom',
            latitude: 53.4808,
            longitude: -2.2426,
          },
          {
            name: 'Manchester',
            admin1: 'New Hampshire',
            country: 'United States',
            latitude: 42.9956,
            longitude: -71.4548,
          },
        ]

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: locationsWithPartialMatch }),
        } as Response)

        const results = await weather.searchLocations('Manchester', null, 'United')

        expect(results).toHaveLength(2) // Both United Kingdom and United States
      })

      it('should handle whitespace trimming in region and country', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', '  England  ', '  United Kingdom  ')

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('England')
        expect(results[0].country).toBe('United Kingdom')
      })

      it('should return all locations when no region matches found', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', 'NonExistentRegion', null)

        // When no region matches are found, the method returns all locations (permissive behavior)
        expect(results).toHaveLength(5)
        expect(results.every((loc) => loc.name === 'London' || loc.name === 'Paris')).toBe(true)
      })

      it('should return all locations when no country matches found', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', null, 'NonExistentCountry')

        // When no country matches are found, the method returns all locations (permissive behavior)
        expect(results).toHaveLength(5)
        expect(results.every((loc) => loc.name === 'London' || loc.name === 'Paris')).toBe(true)
      })

      it('should handle locations with missing admin1 field', async () => {
        const locationsWithMissingAdmin = [
          {
            name: 'TestCity',
            country: 'TestCountry',
            latitude: 40.0,
            longitude: -74.0,
          },
          {
            name: 'TestCity',
            admin1: 'TestRegion',
            country: 'TestCountry',
            latitude: 41.0,
            longitude: -75.0,
          },
        ]

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: locationsWithMissingAdmin }),
        } as Response)

        const results = await weather.searchLocations('TestCity', 'TestRegion', null)

        expect(results).toHaveLength(1)
        expect(results[0].admin1).toBe('TestRegion')
      })

      it('should handle locations with missing country field', async () => {
        const locationsWithMissingCountry = [
          {
            name: 'TestCity',
            admin1: 'TestRegion',
            latitude: 40.0,
            longitude: -74.0,
          },
          {
            name: 'TestCity',
            admin1: 'TestRegion',
            country: 'TestCountry',
            latitude: 41.0,
            longitude: -75.0,
          },
        ]

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: locationsWithMissingCountry }),
        } as Response)

        const results = await weather.searchLocations('TestCity', null, 'TestCountry')

        expect(results).toHaveLength(1)
        expect(results[0].country).toBe('TestCountry')
      })

      it('should handle empty region and country strings', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: mockLocations }),
        } as Response)

        const results = await weather.searchLocations('London', '', '')

        expect(results).toHaveLength(5) // All locations (London and Paris)
        expect(results.every((loc) => loc.name === 'London' || loc.name === 'Paris')).toBe(true)
      })
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

      const result = await weather.getCurrentWeather('London', 'England', 'United Kingdom')

      expect(result).toContain('Current weather for London, England, United Kingdom:')
      expect(result).toContain('Temperature: 15.2°C')
      expect(result).toContain('Feels like: 14.5°C')
      expect(result).toContain('Humidity: 65%')
      expect(result).toContain('Wind: 12.5km/h at 180°')
      expect(result).toContain('Conditions: Mainly clear (Code 1)')
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

      const result = await weather.getCurrentWeather('NonexistentPlace', '', '')

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

      await expect(weather.getCurrentWeather('London', 'England', 'United Kingdom')).rejects.toThrow(
        'Weather API error: 500',
      )
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

      const result = await weather.getCurrentWeather('TestCity', 'TestRegion', 'TestCountry')

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
        weather_code: [1, 2, 3],
        temperature_2m_max: [18.5, 20.1, 16.8],
        temperature_2m_min: [10.2, 12.5, 8.9],
        apparent_temperature_max: [17.8, 19.5, 16.2],
        apparent_temperature_min: [9.5, 11.8, 8.2],
        precipitation_sum: [0.0, 2.5, 5.1],
        precipitation_probability_max: [10, 65, 85],
        wind_speed_10m_max: [15.2, 18.7, 22.1],
      },
      daily_units: {
        temperature_2m_max: '°C',
        temperature_2m_min: '°C',
        apparent_temperature_max: '°C',
        apparent_temperature_min: '°C',
        precipitation_sum: 'mm',
        precipitation_probability_max: '%',
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

      const result = await weather.getWeatherForecast('London', 'England', 'United Kingdom', 3)

      expect(result).toEqual({
        location: 'London, England, United Kingdom',
        days: [
          {
            date: '2024-01-15',
            weather_code: 1,
            temperature_max: 18.5,
            temperature_min: 10.2,
            apparent_temperature_max: 17.8,
            apparent_temperature_min: 9.5,
            precipitation_sum: 0.0,
            precipitation_probability_max: 10,
            wind_speed_10m_max: 15.2,
          },
          {
            date: '2024-01-16',
            weather_code: 2,
            temperature_max: 20.1,
            temperature_min: 12.5,
            apparent_temperature_max: 19.5,
            apparent_temperature_min: 11.8,
            precipitation_sum: 2.5,
            precipitation_probability_max: 65,
            wind_speed_10m_max: 18.7,
          },
          {
            date: '2024-01-17',
            weather_code: 3,
            temperature_max: 16.8,
            temperature_min: 8.9,
            apparent_temperature_max: 16.2,
            apparent_temperature_min: 8.2,
            precipitation_sum: 5.1,
            precipitation_probability_max: 85,
            wind_speed_10m_max: 22.1,
          },
        ],
        temperature_unit: 'c',
      })

      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Check forecast API call
      const forecastCall = mockFetch.mock.calls[1][0] as string
      expect(forecastCall).toContain(
        'daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Capparent_temperature_max%2Capparent_temperature_min%2Cprecipitation_sum%2Cprecipitation_probability_max%2Cwind_speed_10m_max',
      )
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
            weather_code: [1],
            temperature_2m_max: [18.5],
            temperature_2m_min: [10.2],
            apparent_temperature_max: [17.8],
            apparent_temperature_min: [9.5],
            precipitation_sum: [0.0],
            precipitation_probability_max: [10],
            wind_speed_10m_max: [15.2],
          },
        }),
      } as Response)

      const result = await weather.getWeatherForecast('London', 'England', 'United Kingdom', 1)

      expect(result.location).toBe('London, England, United Kingdom')
      expect(result.days).toHaveLength(1)
      expect(result.days[0].date).toBe('2024-01-15')
      expect(result.temperature_unit).toBe('c')

      const forecastCall = mockFetch.mock.calls[1][0] as string
      expect(forecastCall).toContain('forecast_days=1')
    })

    it('should handle location not found for forecast', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response)

      await expect(weather.getWeatherForecast('NonexistentPlace', '', '', 3)).rejects.toThrow(
        "Could not fetch forecast data: Error: Could not find coordinates for location 'NonexistentPlace'",
      )
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

      await expect(weather.getWeatherForecast('London', 'England', 'United Kingdom', 3)).rejects.toThrow(
        'Weather API error: 500',
      )
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

      const result = await weather.getWeatherForecast('London', 'England', 'United Kingdom', 3)

      // Check that dates are returned in the structured format
      expect(result.days[0].date).toBe('2024-01-15')
      expect(result.days[1].date).toBe('2024-01-16')
      expect(result.days[2].date).toBe('2024-01-17')
      expect(result.temperature_unit).toBe('c')
    })

    it('should handle missing forecast data gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLocationData,
      } as Response)

      const emptyForecast = {
        daily: {
          time: [],
          weather_code: [],
          temperature_2m_max: [],
          temperature_2m_min: [],
          apparent_temperature_max: [],
          apparent_temperature_min: [],
          precipitation_sum: [],
          precipitation_probability_max: [],
          wind_speed_10m_max: [],
        },
        daily_units: {},
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => emptyForecast,
      } as Response)

      const result = await weather.getWeatherForecast('London', 'England', 'United Kingdom', 3)

      expect(result.location).toBe('London, England, United Kingdom')
      expect(result.days).toEqual([])
      expect(result.temperature_unit).toBe('c')
      // Should not crash with empty data
    })
  })
})
