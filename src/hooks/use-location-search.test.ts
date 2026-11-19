/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearCachedSession } from '@/lib/session-cache'
import { createMockHttpClient } from '@/test-utils/http-client'
import { spyOn } from 'bun:test'
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { setActiveLocale } from '@/i18n/active-locale'
import { createClient, type HttpClient, type RequestOptions, type ResponsePromise } from '@/lib/http'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useLocationSearch } from './use-location-search'

let consoleSpies: ConsoleSpies
const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl

beforeEach(() => {
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1' })
  setAuthToken('test-session')
})

beforeAll(async () => {
  await setupTestDatabase()
  consoleSpies = setupConsoleSpy()
})

afterAll(async () => {
  consoleSpies.restore()
  await teardownTestDatabase()
})

// The module-level locale and its mirror leak across test files — bun test
// shares one module registry and one happy-dom localStorage for the whole run.
afterEach(() => {
  clearAuthToken()
  useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
  setActiveLocale('en')
  localStorage.removeItem('thunderbolt_locale')
})

const mockLocationResponse = [
  {
    id: 5391959,
    name: 'San Francisco',
    region: 'California',
    country: 'United States',
    countryCode: 'US',
    lat: 37.7749,
    lon: -122.4194,
  },
  {
    id: 5128581,
    name: 'New York',
    region: 'New York',
    country: 'United States',
    countryCode: 'US',
    lat: 40.7128,
    lon: -74.006,
  },
]

describe('useLocationSearch', () => {
  it('does not call a backend in standalone mode', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const { result } = renderHook(() => useLocationSearch(), {
      wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
    })
    act(() => result.current.setSearchQuery('San Francisco'))
    await act(async () => {
      await getClock().tickAsync(300)
    })
    expect(result.current.locations).toEqual([])
  })

  describe('Initial state', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider(),
      })

      expect(result.current.open).toBe(false)
      expect(result.current.searchQuery).toBe('')
      expect(result.current.locations).toEqual([])
      expect(result.current.isSearching).toBe(false)
    })

    it('should provide control functions', () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider(),
      })

      expect(typeof result.current.setOpen).toBe('function')
      expect(typeof result.current.setSearchQuery).toBe('function')
      expect(typeof result.current.clearSearch).toBe('function')
    })
  })

  describe('State management', () => {
    it('should handle opening and closing', () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider(),
      })

      act(() => {
        result.current.setOpen(true)
      })

      expect(result.current.open).toBe(true)

      act(() => {
        result.current.setOpen(false)
      })

      expect(result.current.open).toBe(false)
    })

    it('should handle search query changes', () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider(),
      })

      act(() => {
        result.current.setSearchQuery('New York')
      })

      expect(result.current.searchQuery).toBe('New York')
    })

    it('should clear search when clearSearch is called', () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider(),
      })

      // Set some state first
      act(() => {
        result.current.setSearchQuery('New York')
      })

      expect(result.current.searchQuery).toBe('New York')

      // Clear search
      act(() => {
        result.current.clearSearch()
      })

      expect(result.current.searchQuery).toBe('')
      expect(result.current.locations).toEqual([])
    })
  })

  describe('Location search functionality', () => {
    it('should not search when query is too short', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
      })

      // Single character query
      act(() => {
        result.current.setSearchQuery('a')
      })

      // Wait for debounce (300ms)
      await act(async () => {
        await getClock().tickAsync(300)
      })

      // Should not have any locations for short queries
      expect(result.current.locations).toEqual([])
    })

    it('should search when query is long enough', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
      })

      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      // Wait for debounce (300ms) and API call
      await act(async () => {
        await getClock().tickAsync(300)
      })

      expect(result.current.locations).toEqual([
        {
          id: 5391959,
          name: 'San Francisco, California, United States',
          city: 'San Francisco',
          countryCode: 'US',
          coordinates: {
            lat: 37.7749,
            lng: -122.4194,
          },
        },
        {
          id: 5128581,
          name: 'New York, New York, United States',
          city: 'New York',
          countryCode: 'US',
          coordinates: {
            lat: 40.7128,
            lng: -74.006,
          },
        },
      ])
    })

    /**
     * Open-Meteo's `language` narrows what it *matches*, not just what it
     * renders: `Munique` finds Munich under `pt` and only Muñique, Spain under
     * `en`. Someone searching in their own language has to be able to find
     * their own city, so the active locale rides along with the query.
     */
    it('should search in the active locale', async () => {
      const recorded: Array<Record<string, unknown>> = []
      const recordingClient: HttpClient = {
        get: (url: string, options?: RequestOptions) => {
          // The AuthProvider's startup session check is not a search.
          if (url !== 'api/auth/get-session') {
            recorded.push((options?.searchParams ?? {}) as Record<string, unknown>)
          }
          const promise = Promise.resolve(new Response('[]')) as ResponsePromise
          promise.json = async <T>() => [] as T
          promise.text = async () => '[]'
          return promise
        },
        post: () => {
          throw new Error('not implemented')
        },
        delete: () => {
          throw new Error('not implemented')
        },
      }

      setActiveLocale('pt-BR')
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ httpClient: recordingClient }),
      })

      act(() => {
        result.current.setSearchQuery('Munique')
      })

      await act(async () => {
        await getClock().tickAsync(300)
      })

      expect(recorded[0]).toEqual({ query: 'Munique', language: 'pt-BR' })
    })

    it('should handle search errors gracefully', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: [] }),
      })

      act(() => {
        result.current.setSearchQuery('New York')
      })

      // Wait for debounce (300ms) and all async operations to complete
      await act(async () => {
        await getClock().runAllAsync()
      })

      // Additional act to ensure state updates from the finally block are processed
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.locations).toEqual([])
      expect(result.current.isSearching).toBe(false)
    })

    it('should show loading state during search', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
      })

      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      // Check loading state before debounce completes
      expect(result.current.isSearching).toBe(false)

      // Wait for debounce (300ms) to trigger search, then wait for response
      await act(async () => {
        await getClock().runAllAsync()
      })

      // After all async operations complete, loading should be false and data should be present
      expect(result.current.isSearching).toBe(false)
      expect(result.current.locations.length).toBeGreaterThan(0)
    })

    it('should transform API response correctly', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
      })

      act(() => {
        result.current.setSearchQuery('test')
      })

      // Wait for debounce (300ms)
      await act(async () => {
        await getClock().tickAsync(300)
      })

      expect(result.current.locations.length).toBeGreaterThan(0)

      // Verify transformation
      const firstLocation = result.current.locations[0]
      expect(firstLocation).toHaveProperty('name')
      expect(firstLocation).toHaveProperty('city')
      expect(firstLocation).toHaveProperty('coordinates')
      expect(firstLocation.coordinates).toHaveProperty('lat')
      expect(firstLocation.coordinates).toHaveProperty('lng')
    })
  })

  describe('Edge cases', () => {
    it('should handle empty search results', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: [] }),
      })

      act(() => {
        result.current.setSearchQuery('NonExistentLocation')
      })

      // Wait for debounce (300ms)
      await act(async () => {
        await getClock().tickAsync(300)
      })

      expect(result.current.isSearching).toBe(false)
      expect(result.current.locations).toEqual([])
    })

    it('should handle query with only whitespace', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
      })

      act(() => {
        result.current.setSearchQuery('   ')
      })

      // Wait for debounce (300ms)
      await act(async () => {
        await getClock().tickAsync(300)
      })

      // Should not make API call for whitespace-only queries
      expect(result.current.locations).toEqual([])
    })

    it('should update results when query changes', async () => {
      const { result } = renderHook(() => useLocationSearch(), {
        wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
      })

      // First query
      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      // Wait for debounce (300ms)
      await act(async () => {
        await getClock().tickAsync(300)
      })

      expect(result.current.locations.length).toBeGreaterThan(0)

      // Change query
      act(() => {
        result.current.setSearchQuery('New York')
      })

      // Wait for debounce (300ms)
      await act(async () => {
        await getClock().tickAsync(300)
      })

      // Results should update (may be same in mock, but query changed)
      expect(result.current.searchQuery).toBe('New York')
    })
  })
})

it('does not look up a city on a selected but unauthenticated backend', async () => {
  clearAuthToken()
  clearCachedSession()
  const client = createMockHttpClient(mockLocationResponse)
  const get = spyOn(client, 'get')
  const { result } = renderHook(useLocationSearch, {
    wrapper: createTestProvider({ httpClient: client }),
  })
  act(() => result.current.setSearchQuery('San Francisco'))
  await act(async () => {
    await getClock().tickAsync(300)
  })
  expect(result.current.locations).toEqual([])
  expect(get.mock.calls.some(([url]) => url === 'locations')).toBe(false)
  get.mockRestore()
})

describe('search request ownership', () => {
  it('retains results when the combobox repeats the current query', async () => {
    const { result } = renderHook(() => useLocationSearch(), {
      wrapper: createTestProvider({ mockResponse: mockLocationResponse }),
    })
    act(() => result.current.setSearchQuery('San Francisco'))
    await act(async () => {
      await getClock().tickAsync(300)
    })
    const results = result.current.locations
    act(() => result.current.setSearchQuery('San Francisco'))
    expect(result.current.locations).toBe(results)
    expect(result.current.isSearching).toBe(false)
  })

  it('settles a failed request and permits the next query to succeed', async () => {
    const rejected = Promise.withResolvers<Response>()
    const httpClient = createClient({
      prefixUrl: 'https://example.com',
      fetch: (input) => {
        const url = String(input instanceof Request ? input.url : input)
        if (!url.includes('/locations?')) {
          return Promise.resolve(Response.json({}))
        }
        return url.includes('fail') ? rejected.promise : Promise.resolve(Response.json(mockLocationResponse))
      },
    })
    const { result } = renderHook(() => useLocationSearch(), { wrapper: createTestProvider({ httpClient }) })
    act(() => result.current.setSearchQuery('fail'))
    await act(async () => {
      await getClock().tickAsync(300)
    })
    expect(result.current.isSearching).toBe(true)
    await act(async () => {
      rejected.reject(new Error('offline'))
      await getClock().tickAsync(0)
    })
    expect(result.current.isSearching).toBe(false)
    expect(result.current.locations).toEqual([])
    act(() => result.current.setSearchQuery('San Francisco'))
    await act(async () => {
      await getClock().tickAsync(300)
    })
    expect(result.current.locations).toHaveLength(2)
  })

  it.each(['replace', 'clear', 'edit'] as const)('ignores old results after %s', async (action) => {
    const old = Promise.withResolvers<Response>()
    const fresh = Promise.withResolvers<Response>()
    const queue = [old, fresh]
    const httpClient = createClient({
      prefixUrl: 'https://example.com',
      fetch: (input) =>
        String(input instanceof Request ? input.url : input).includes('/locations?')
          ? queue.shift()!.promise
          : Promise.resolve(Response.json({})),
    })
    const { result } = renderHook(() => useLocationSearch(), { wrapper: createTestProvider({ httpClient }) })
    act(() => result.current.setSearchQuery('San Francisco'))
    await act(async () => {
      await getClock().tickAsync(300)
    })
    act(() => (action === 'clear' ? result.current.clearSearch() : result.current.setSearchQuery('New York')))
    if (action === 'replace') {
      await act(async () => {
        await getClock().tickAsync(300)
      })
      await act(async () => {
        fresh.resolve(Response.json([mockLocationResponse[1]]))
        await getClock().tickAsync(0)
      })
    }
    await act(async () => {
      old.resolve(Response.json([mockLocationResponse[0]]))
      await getClock().tickAsync(0)
    })
    expect(result.current.locations.map((location) => location.city)).toEqual(action === 'replace' ? ['New York'] : [])
    expect(result.current.isSearching).toBe(false)
  })
})
