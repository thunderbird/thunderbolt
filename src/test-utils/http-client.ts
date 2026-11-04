/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

/**
 * A client for a fake backend at `http://backend.test` that answers each
 * request path (without the leading slash) with `respond`'s body, or fails the
 * request when it returns undefined. Records every requested path.
 * @param respond - The body for a path, or undefined to fail that request.
 */
export const createRecordingClient = (respond: (path: string) => BodyInit | undefined) => {
  const requests: string[] = []
  const client = createClient({
    prefixUrl: 'http://backend.test',
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname.slice(1)
      requests.push(path)
      const body = respond(path)
      if (body === undefined) {
        throw new Error('offline')
      }
      return new Response(body)
    },
  })
  return { client, requests }
}
