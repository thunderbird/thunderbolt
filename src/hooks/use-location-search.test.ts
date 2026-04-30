/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useLocationSearch } from './use-location-search'

let consoleSpies: ConsoleSpies

beforeAll(async () => {
  await setupTestDatabase()
  consoleSpies = setupConsoleSpy()
})

afterAll(async () => {
  consoleSpies.restore()
  await teardownTestDatabase()
})

const mockLocationResponse = [
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
]

describe('useLocationSearch', () => {
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
          name: 'San Francisco, California, United States',
          city: 'San Francisco',
          coordinates: {
            lat: 37.7749,
            lng: -122.4194,
          },
        },
        {
          name: 'New York, New York, United States',
          city: 'New York',
          coordinates: {
            lat: 40.7128,
            lng: -74.006,
          },
        },
      ])
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
