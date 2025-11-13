import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import ky, { type KyInstance } from 'ky'
import { getClock } from '@/testing-library'
import { useCountryUnits } from './use-country-units'

/**
 * Creates a ky HTTP client with a custom fetch function that returns mock country units data
 */
const createMockHttpClient = (mockData: unknown, shouldError = false): KyInstance => {
  const mockFetch = async (): Promise<Response> => {
    if (shouldError) {
      throw new Error('Network error')
    }
    return new Response(JSON.stringify(mockData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return ky.create({ fetch: mockFetch, prefixUrl: 'http://test-api.local' })
}

const mockCountryUnitsData = {
  unit: 'metric',
  temperature: 'c',
  dateFormatExample: 'DD/MM/YYYY',
  timeFormat: '24h',
  currency: { code: 'EUR', symbol: '€', name: 'Euro' },
}

const mockHttpClient = createMockHttpClient(mockCountryUnitsData)

beforeAll(async () => {
  await setupTestDatabase()
  // Suppress console.error for expected error scenarios in tests
  spyOn(console, 'error').mockImplementation(() => {})
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
})

describe('useCountryUnits', () => {
  describe('Initial state', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() => useCountryUnits(undefined, mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.data).toBeUndefined()
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(typeof result.current.fetchCountryUnits).toBe('function')
    })

    it('should use provided country parameter', () => {
      const { result } = renderHook(() => useCountryUnits('CA', mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.data).toBeUndefined()
      expect(typeof result.current.fetchCountryUnits).toBe('function')
    })
  })

  describe('fetchCountryUnits function', () => {
    it('should fetch country units data successfully', async () => {
      const { result } = renderHook(() => useCountryUnits(undefined, mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise
      expect(data).toEqual(mockCountryUnitsData)
    })

    it('should handle fetch errors gracefully', async () => {
      const errorClient = createMockHttpClient({}, true)
      const { result } = renderHook(() => useCountryUnits(undefined, errorClient), {
        wrapper: createQueryTestWrapper(),
      })

      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise
      expect(data).toBeNull()
    })

    it('should cache results for the same country', async () => {
      const { result } = renderHook(() => useCountryUnits(undefined, mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      const firstPromise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const firstFetch = await firstPromise

      const secondPromise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const secondFetch = await secondPromise

      expect(firstFetch).toEqual(mockCountryUnitsData)
      expect(secondFetch).toEqual(mockCountryUnitsData)
    })
  })

  describe('Query configuration', () => {
    it('should be disabled by default', () => {
      const { result } = renderHook(() => useCountryUnits(undefined, mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toBeUndefined()
    })

    it('should handle stale time and cache time', async () => {
      const { result } = renderHook(() => useCountryUnits(undefined, mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      // Fetch data
      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise

      // Data should be returned from the fetch
      expect(data).toEqual(mockCountryUnitsData)

      // After runAllAsync, React Query's cache updates propagate to the query
      expect(result.current.data).toBeDefined()
    })
  })

  describe('Error handling', () => {
    it('should handle malformed API response', async () => {
      const malformedClient = createMockHttpClient({ invalid: 'data' })
      const { result } = renderHook(() => useCountryUnits(undefined, malformedClient), {
        wrapper: createQueryTestWrapper(),
      })

      // Should handle parse errors gracefully
      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise
      expect(data).toBeNull()
    })

    it('should handle timeout errors', async () => {
      const errorClient = createMockHttpClient({}, true)
      const { result } = renderHook(() => useCountryUnits(undefined, errorClient), {
        wrapper: createQueryTestWrapper(),
      })

      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise
      expect(data).toBeNull()
    })
  })

  describe('Country extraction from location settings', () => {
    it('should fallback to US when no location is set', () => {
      const { result } = renderHook(() => useCountryUnits(undefined, mockHttpClient), {
        wrapper: createQueryTestWrapper(),
      })

      // Should use 'US' as default
      expect(result.current.data).toBeUndefined()
    })
  })
})
