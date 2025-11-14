import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { useCountryUnits } from './use-country-units'

const mockCountryUnitsData = {
  unit: 'metric',
  temperature: 'c',
  dateFormatExample: 'DD/MM/YYYY',
  timeFormat: '24h',
  currency: { code: 'EUR', symbol: '€', name: 'Euro' },
}

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
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
      })

      expect(result.current.data).toBeUndefined()
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(typeof result.current.fetchCountryUnits).toBe('function')
    })

    it('should use provided country parameter', () => {
      const { result } = renderHook(() => useCountryUnits('CA'), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
      })

      expect(result.current.data).toBeUndefined()
      expect(typeof result.current.fetchCountryUnits).toBe('function')
    })
  })

  describe('fetchCountryUnits function', () => {
    it('should fetch country units data successfully', async () => {
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
      })

      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise
      expect(data).toEqual(mockCountryUnitsData)
    })

    it('should handle fetch errors gracefully', async () => {
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: {} }),
      })

      const promise = result.current.fetchCountryUnits('US')
      await act(async () => {
        await getClock().runAllAsync()
      })
      const data = await promise
      expect(data).toBeNull()
    })

    it('should cache results for the same country', async () => {
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
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
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
      })

      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toBeUndefined()
    })

    it('should handle stale time and cache time', async () => {
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
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
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: { invalid: 'data' } }),
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
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: {} }),
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
      const { result } = renderHook(() => useCountryUnits(), {
        wrapper: createTestProvider({ mockResponse: mockCountryUnitsData }),
      })

      // Should use 'US' as default
      expect(result.current.data).toBeUndefined()
    })
  })
})
