import type { HttpClient } from '@/hooks/use-location-search'

/**
 * Creates a mock HTTP client for testing that returns mock location data
 */
export const createMockHttpClient = (mockLocations: any[] = []): HttpClient => {
  return {
    get: (url: string, options?: { searchParams?: Record<string, string> }) => {
      return {
        json: async <T>() => {
          // Return mock locations based on the query
          return mockLocations as T
        },
      }
    },
  }
}

/**
 * Default mock locations for testing
 */
export const mockLocationData = [
  {
    name: 'San Francisco',
    region: 'California',
    country: 'United States',
    lat: 37.7749,
    lon: -122.4194,
  },
  {
    name: 'New York',
    region: 'New York',
    country: 'United States',
    lat: 40.7128,
    lon: -74.006,
  },
  {
    name: 'London',
    region: 'England',
    country: 'United Kingdom',
    lat: 51.5074,
    lon: -0.1278,
  },
]
