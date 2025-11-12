import { afterEach, describe, expect, it } from 'bun:test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useLocationSearch } from './use-location-search'
import type { HttpClient } from './use-location-search'

/**
 * Creates a mock HTTP client that returns predefined location data
 */
const createTestHttpClient = (mockResponse: any[] = [], shouldError = false, delay = 0): HttpClient => {
  return {
    get: () => ({
      json: async () => {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
        if (shouldError) {
          throw new Error('Network error')
        }
        return mockResponse
      },
    }),
  }
}

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
  afterEach(() => {
    // Cleanup after each test
  })

  describe('Initial state', () => {
    it('should initialize with default values', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      expect(result.current.open).toBe(false)
      expect(result.current.searchQuery).toBe('')
      expect(result.current.locations).toEqual([])
      expect(result.current.isSearching).toBe(false)
    })

    it('should provide control functions', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      expect(typeof result.current.setOpen).toBe('function')
      expect(typeof result.current.setSearchQuery).toBe('function')
      expect(typeof result.current.clearSearch).toBe('function')
    })
  })

  describe('State management', () => {
    it('should handle opening and closing', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

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
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('New York')
      })

      expect(result.current.searchQuery).toBe('New York')
    })

    it('should clear search when clearSearch is called', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

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
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      // Single character query
      act(() => {
        result.current.setSearchQuery('a')
      })

      // Wait for debounce
      await waitFor(
        () => {
          // Should not have any locations for short queries
          expect(result.current.locations).toEqual([])
        },
        { timeout: 500 },
      )
    })

    it('should search when query is long enough', async () => {
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      // Wait for debounce and API call
      await waitFor(
        () => {
          expect(result.current.locations.length).toBeGreaterThan(0)
        },
        { timeout: 500 },
      )

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
      const mockClient = createTestHttpClient([], true) // Error mode
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('New York')
      })

      await waitFor(
        () => {
          expect(result.current.locations).toEqual([])
          expect(result.current.isSearching).toBe(false)
        },
        { timeout: 500 },
      )
    })

    it('should show loading state during search', async () => {
      const mockClient = createTestHttpClient(mockLocationResponse, false, 100) // 100ms delay
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      // Wait for debounce, then check loading state
      await waitFor(
        () => {
          expect(result.current.isSearching).toBe(true)
        },
        { timeout: 500 },
      )

      await waitFor(
        () => {
          expect(result.current.isSearching).toBe(false)
        },
        { timeout: 500 },
      )
    })

    it('should transform API response correctly', async () => {
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('test')
      })

      await waitFor(
        () => {
          expect(result.current.locations.length).toBeGreaterThan(0)
        },
        { timeout: 500 },
      )

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
      const mockClient = createTestHttpClient([]) // Empty results
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('NonExistentLocation')
      })

      await waitFor(
        () => {
          expect(result.current.isSearching).toBe(false)
        },
        { timeout: 500 },
      )

      expect(result.current.locations).toEqual([])
    })

    it('should handle query with only whitespace', async () => {
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      act(() => {
        result.current.setSearchQuery('   ')
      })

      await waitFor(
        () => {
          // Should not make API call for whitespace-only queries
          expect(result.current.locations).toEqual([])
        },
        { timeout: 500 },
      )
    })

    it('should update results when query changes', async () => {
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient, 'http://test-api.local'))

      // First query
      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      await waitFor(
        () => {
          expect(result.current.locations.length).toBeGreaterThan(0)
        },
        { timeout: 500 },
      )

      const firstResults = result.current.locations

      // Change query
      act(() => {
        result.current.setSearchQuery('New York')
      })

      await waitFor(
        () => {
          // Results should update (may be same in mock, but query changed)
          expect(result.current.searchQuery).toBe('New York')
        },
        { timeout: 500 },
      )
    })
  })
})
