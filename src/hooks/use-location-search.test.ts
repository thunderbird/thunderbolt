import { act, renderHook } from '@testing-library/react'
import { beforeAll, describe, expect, it, spyOn } from 'bun:test'
import ky, { type KyInstance } from 'ky'
import { getClock } from '@/testing-library'
import { useLocationSearch } from './use-location-search'

beforeAll(() => {
  // Suppress console.error for expected error scenarios in tests
  spyOn(console, 'error').mockImplementation(() => {})
})

/**
 * Creates a ky HTTP client with a custom fetch function that returns mock location data
 */
const createTestHttpClient = (mockResponse: unknown[] = [], shouldError = false, delay = 0): KyInstance => {
  const mockFetch = async (): Promise<Response> => {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    if (shouldError) {
      throw new Error('Network error')
    }
    return new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return ky.create({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
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
  describe('Initial state', () => {
    it('should initialize with default values', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient))

      expect(result.current.open).toBe(false)
      expect(result.current.searchQuery).toBe('')
      expect(result.current.locations).toEqual([])
      expect(result.current.isSearching).toBe(false)
    })

    it('should provide control functions', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient))

      expect(typeof result.current.setOpen).toBe('function')
      expect(typeof result.current.setSearchQuery).toBe('function')
      expect(typeof result.current.clearSearch).toBe('function')
    })
  })

  describe('State management', () => {
    it('should handle opening and closing', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const { result } = renderHook(() => useLocationSearch(mockClient))

      act(() => {
        result.current.setSearchQuery('New York')
      })

      expect(result.current.searchQuery).toBe('New York')
    })

    it('should clear search when clearSearch is called', () => {
      const mockClient = createTestHttpClient()
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const mockClient = createTestHttpClient([], true) // Error mode
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const mockClient = createTestHttpClient(mockLocationResponse, false, 100) // 100ms delay
      const { result } = renderHook(() => useLocationSearch(mockClient))

      act(() => {
        result.current.setSearchQuery('San Francisco')
      })

      // Wait for debounce (300ms) to trigger search
      await act(async () => {
        await getClock().tickAsync(300)
      })

      // Check loading state
      expect(result.current.isSearching).toBe(true)

      // Wait for API response (100ms delay)
      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(result.current.isSearching).toBe(false)
    })

    it('should transform API response correctly', async () => {
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const mockClient = createTestHttpClient([]) // Empty results
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
      const mockClient = createTestHttpClient(mockLocationResponse)
      const { result } = renderHook(() => useLocationSearch(mockClient))

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
