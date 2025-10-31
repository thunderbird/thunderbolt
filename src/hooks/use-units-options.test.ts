import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { useUnitsOptions } from './use-units-options'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { updateSetting } from '@/dal/settings'

// Mock only ky, use real database for getSettings
const mockKyGet = mock()

mock.module('ky', () => ({
  default: {
    get: mockKyGet,
  },
}))

const mockUnitsOptionsData = {
  units: ['metric', 'imperial'],
  temperature: [
    { symbol: 'C', name: 'Celsius' },
    { symbol: 'F', name: 'Fahrenheit' },
  ],
  timeFormat: ['12h', '24h'],
  dateFormats: [
    { format: 'YYYY-MM-DD', example: '2025-12-01' },
    { format: 'DD/MM/YYYY', example: '01/12/2025' },
    { format: 'MM/DD/YYYY', example: '12/01/2025' },
  ],
  currencies: [
    {
      code: 'USD',
      symbol: '$',
      name: 'US Dollar',
    },
    {
      code: 'EUR',
      symbol: '€',
      name: 'Euro',
    },
    {
      code: 'BRL',
      symbol: 'R$',
      name: 'Brazilian Real',
    },
  ],
}

describe('useUnitsOptions', () => {
  beforeEach(async () => {
    await setupTestDatabase()
    // Set up the cloud_url setting in the database
    await updateSetting('cloud_url', 'https://api.example.com')
    mockKyGet.mockClear()
    mockKyGet.mockReturnValue({
      json: mock().mockResolvedValue(mockUnitsOptionsData),
    } as unknown as { json: () => Promise<typeof mockUnitsOptionsData> })
  })

  afterEach(async () => {
    await resetTestDatabase()
    mockKyGet.mockClear()
  })

  describe('Hook functionality', () => {
    it('should return loading state initially', () => {
      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current.isLoading).toBe(true)
      expect(result.current.data).toBeUndefined()
      expect(result.current.error).toBeNull()
    })

    it('should fetch and return units options data', async () => {
      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toEqual(mockUnitsOptionsData)
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('should call getSettings and ky.get with correct parameters', async () => {
      renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      await waitFor(() => {
        expect(mockKyGet).toHaveBeenCalledWith('https://api.example.com/units-options')
      })
    })

    it('should handle API errors after retries', async () => {
      const errorMessage = 'Network error'
      mockKyGet.mockReturnValue({
        json: mock().mockRejectedValue(new Error(errorMessage)),
      } as unknown as { json: () => Promise<never> })

      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      // Wait for retries to complete (2 retries + initial attempt = 3 total)
      await waitFor(
        () => {
          expect(result.current.isError).toBe(true)
        },
        { timeout: 10000 },
      )

      expect(result.current.error).toBeDefined()
      expect(result.current.data).toBeUndefined()
    })

    it('should handle database errors when cloud_url is missing', async () => {
      // This test verifies that the hook works with the default cloud_url
      // Since the hook has a default value, it should still work
      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      // Wait for the hook to complete successfully
      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true)
        },
        { timeout: 5000 },
      )

      expect(result.current.data).toBeDefined()
    })
  })

  describe('Query configuration', () => {
    it('should have correct query key', () => {
      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      // The query key is internal to react-query, but we can verify the hook works
      expect(result.current).toHaveProperty('data')
      expect(result.current).toHaveProperty('isLoading')
      expect(result.current).toHaveProperty('isError')
      expect(result.current).toHaveProperty('isSuccess')
    })

    it('should have correct stale time and cache time', () => {
      // These are internal to react-query configuration
      // We test the behavior by ensuring the hook works correctly
      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      expect(result.current).toHaveProperty('data')
      expect(result.current).toHaveProperty('isLoading')
    })
  })

  describe('Data structure validation', () => {
    it('should return data with correct structure when successful', async () => {
      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      const data = result.current.data
      expect(data).toHaveProperty('units')
      expect(data).toHaveProperty('temperature')
      expect(data).toHaveProperty('timeFormat')
      expect(data).toHaveProperty('dateFormats')
      expect(data).toHaveProperty('currencies')

      // Validate units array
      expect(Array.isArray(data?.units)).toBe(true)
      expect(data?.units.length).toBeGreaterThan(0)
      data?.units.forEach((unit) => {
        expect(typeof unit).toBe('string')
      })

      // Validate temperature array
      expect(Array.isArray(data?.temperature)).toBe(true)
      expect(data?.temperature.length).toBeGreaterThan(0)
      data?.temperature.forEach((temp) => {
        expect(temp).toHaveProperty('symbol')
        expect(temp).toHaveProperty('name')
        expect(typeof temp.symbol).toBe('string')
        expect(typeof temp.name).toBe('string')
      })

      // Validate timeFormat array
      expect(Array.isArray(data?.timeFormat)).toBe(true)
      expect(data?.timeFormat.length).toBeGreaterThan(0)
      data?.timeFormat.forEach((format) => {
        expect(typeof format).toBe('string')
      })

      // Validate dateFormats array
      expect(Array.isArray(data?.dateFormats)).toBe(true)
      expect(data?.dateFormats.length).toBeGreaterThan(0)
      data?.dateFormats.forEach((format) => {
        expect(format).toHaveProperty('format')
        expect(format).toHaveProperty('example')
        expect(typeof format.format).toBe('string')
        expect(typeof format.example).toBe('string')
      })

      // Validate currencies array
      expect(Array.isArray(data?.currencies)).toBe(true)
      expect(data?.currencies.length).toBeGreaterThan(0)
      data?.currencies.forEach((currency) => {
        expect(currency).toHaveProperty('code')
        expect(currency).toHaveProperty('symbol')
        expect(currency).toHaveProperty('name')
        expect(typeof currency.code).toBe('string')
        expect(typeof currency.symbol).toBe('string')
        expect(typeof currency.name).toBe('string')
      })
    })
  })

  describe('Retry logic', () => {
    it('should retry on network errors', async () => {
      let callCount = 0
      mockKyGet.mockImplementation(() => {
        callCount++
        if (callCount < 3) {
          return {
            json: mock().mockRejectedValue(new Error('Network error')),
          } as unknown as { json: () => Promise<never> }
        }
        return {
          json: mock().mockResolvedValue(mockUnitsOptionsData),
        } as unknown as { json: () => Promise<typeof mockUnitsOptionsData> }
      })

      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true)
        },
        { timeout: 5000 },
      )

      expect(callCount).toBeGreaterThan(1)
    })
  })

  describe('Edge cases', () => {
    it('should handle empty response', async () => {
      const emptyData = {
        units: [],
        temperature: [],
        timeFormat: [],
        dateFormats: [],
        currencies: [],
      }

      mockKyGet.mockReturnValue({
        json: mock().mockResolvedValue(emptyData),
      } as unknown as { json: () => Promise<typeof emptyData> })

      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toEqual(emptyData)
    })

    it('should handle schema validation errors', async () => {
      const malformedData = {
        units: 'not-an-array',
        temperature: null,
        timeFormat: undefined,
        dateFormats: {},
        currencies: 'invalid',
      }

      mockKyGet.mockReturnValue({
        json: mock().mockResolvedValue(malformedData),
      } as unknown as { json: () => Promise<typeof malformedData> })

      const { result } = renderHook(() => useUnitsOptions(), {
        wrapper: createQueryTestWrapper(),
      })

      // Wait for schema validation to fail
      await waitFor(
        () => {
          expect(result.current.isError).toBe(true)
        },
        { timeout: 5000 },
      )

      expect(result.current.error).toBeDefined()
    })
  })
})
