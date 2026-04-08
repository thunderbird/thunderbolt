import { createClient, type HttpClient } from '@/lib/http'

/**
 * Creates an HTTP client with a custom fetch function that returns mock data
 * @param mockResponse - The mock data to return
 * @param prefixUrl - Optional base URL for the client (defaults to http://test-api.local)
 */
export const createMockHttpClient = (mockResponse: unknown = [], prefixUrl = 'http://test-api.local'): HttpClient => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return createClient({ fetch: mockFetch, prefixUrl })
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
