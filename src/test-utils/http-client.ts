/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
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

/** Build a JSON Response (for use with createSpyHttpClient). */
export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Creates an HTTP client backed by a Bun mock spy, for asserting on requests. */
export const createSpyHttpClient = (
  fetchImpl?: (req: Request) => Promise<Response>,
  defaultResponse: unknown = { success: true },
): { httpClient: HttpClient; fetchSpy: ReturnType<typeof mock> } => {
  const defaultImpl = async () => jsonResponse(defaultResponse)
  const fetchSpy = mock(fetchImpl ?? defaultImpl)
  const httpClient = createClient({
    fetch: fetchSpy as unknown as typeof globalThis.fetch,
    prefixUrl: 'http://test-api.local',
  })
  return { httpClient, fetchSpy }
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
