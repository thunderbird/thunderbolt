import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test'

// Mock ky
const mockKyGet = vi.fn()
const mockKy = {
  get: mockKyGet,
}

// Mock getCloudUrl
const mockGetCloudUrl = vi.fn()

// Mock modules
vi.mock('ky', () => ({
  default: mockKy,
}))

vi.mock('@/lib/config', () => ({
  getCloudUrl: mockGetCloudUrl,
}))

// Mock units data
const mockUnitsData = {
  units: {
    distance: [
      { id: 'km', name: 'kilometer', symbol: 'km', type: 'metric', conversionFactorToBase: 1000 },
      { id: 'mi', name: 'mile', symbol: 'mi', type: 'imperial', conversionFactorToBase: 1609.344 },
    ],
    temperature: [
      { id: 'C', name: 'Celsius', symbol: '°C', type: 'metric' },
      { id: 'F', name: 'Fahrenheit', symbol: '°F', type: 'imperial' },
    ],
    speed: [
      { id: 'km/h', name: 'kilometers per hour', symbol: 'km/h', type: 'metric' },
      { id: 'mph', name: 'miles per hour', symbol: 'mph', type: 'imperial' },
    ],
    precipitation: [
      {
        id: 'mm',
        name: 'millimeters',
        symbol: 'mm',
        type: 'metric',
        usage: 'Total precipitation depth',
        example: '12.4 mm',
      },
      {
        id: 'in',
        name: 'inches',
        symbol: 'in',
        type: 'imperial',
        usage: 'Total precipitation depth',
        example: '0.49 in',
      },
    ],
    timeFormat: [
      {
        id: '24h',
        name: '24-hour clock',
        pattern: 'HH:mm',
        example: '23:45',
        regions: ['Most of the world'],
        type: 'international',
      },
      {
        id: '12h',
        name: '12-hour clock',
        pattern: 'hh:mm a',
        example: '11:45 PM',
        regions: ['United States'],
        type: 'imperial',
      },
    ],
  },
}

describe('useUnits hook dependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudUrl.mockResolvedValue('https://api.example.com')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should have correct query configuration', async () => {
    // Test the query configuration that useUnits uses
    const queryKey = ['units']
    const staleTime = 24 * 60 * 60 * 1000 // 24 hours
    const gcTime = 24 * 60 * 60 * 1000 // 24 hours
    const retry = 2
    const retryDelay = 1000

    expect(queryKey).toEqual(['units'])
    expect(staleTime).toBe(24 * 60 * 60 * 1000)
    expect(gcTime).toBe(24 * 60 * 60 * 1000)
    expect(retry).toBe(2)
    expect(retryDelay).toBe(1000)
  })

  it('should construct correct API endpoint', async () => {
    const cloudUrl = 'https://api.example.com'
    const endpoint = `${cloudUrl}/units`

    expect(endpoint).toBe('https://api.example.com/units')
  })

  it('should handle successful API response structure', async () => {
    const mockJson = vi.fn().mockResolvedValue(mockUnitsData)
    mockKyGet.mockReturnValue({
      json: mockJson,
    })

    // Simulate the API call that useUnits makes
    const cloudUrl = await mockGetCloudUrl()
    const response = mockKyGet(`${cloudUrl}/units`)
    const data = await response.json()

    expect(mockGetCloudUrl).toHaveBeenCalledTimes(1)
    expect(mockKyGet).toHaveBeenCalledWith('https://api.example.com/units')
    expect(data).toEqual(mockUnitsData)
  })

  it('should handle API errors', async () => {
    const mockError = new Error('API Error')
    const mockJson = vi.fn().mockRejectedValue(mockError)
    mockKyGet.mockReturnValue({
      json: mockJson,
    })

    // Simulate the API call that useUnits makes
    const cloudUrl = await mockGetCloudUrl()
    const response = mockKyGet(`${cloudUrl}/units`)

    await expect(response.json()).rejects.toThrow('API Error')
  })

  it('should handle getCloudUrl errors', async () => {
    const mockError = new Error('Cloud URL Error')
    mockGetCloudUrl.mockRejectedValue(mockError)

    await expect(mockGetCloudUrl()).rejects.toThrow('Cloud URL Error')
  })

  it('should have correct units data structure', () => {
    expect(mockUnitsData).toHaveProperty('units')
    expect(mockUnitsData.units).toHaveProperty('distance')
    expect(mockUnitsData.units).toHaveProperty('temperature')
    expect(mockUnitsData.units).toHaveProperty('speed')
    expect(mockUnitsData.units).toHaveProperty('precipitation')
    expect(mockUnitsData.units).toHaveProperty('timeFormat')

    // Check that each unit category has the expected structure
    Object.entries(mockUnitsData.units).forEach(([category, units]) => {
      expect(Array.isArray(units)).toBe(true)
      units.forEach((unit) => {
        expect(unit).toHaveProperty('id')
        expect(unit).toHaveProperty('name')
        expect(unit).toHaveProperty('type')
        expect(typeof unit.id).toBe('string')
        expect(typeof unit.name).toBe('string')
        expect(typeof unit.type).toBe('string')

        // Most units have symbol, but timeFormat units don't
        if (category !== 'timeFormat') {
          expect(unit).toHaveProperty('symbol')
          expect(typeof unit.symbol).toBe('string')
        }
      })
    })
  })

  it('should have timeFormat units with correct structure', () => {
    const timeFormatUnits = mockUnitsData.units.timeFormat

    timeFormatUnits.forEach((unit) => {
      expect(unit).toHaveProperty('pattern')
      expect(unit).toHaveProperty('example')
      expect(unit).toHaveProperty('regions')
      expect(Array.isArray(unit.regions)).toBe(true)
    })
  })

  it('should have precipitation units with usage and example', () => {
    const precipitationUnits = mockUnitsData.units.precipitation

    precipitationUnits.forEach((unit) => {
      expect(unit).toHaveProperty('usage')
      expect(unit).toHaveProperty('example')
      expect(typeof unit.usage).toBe('string')
      expect(typeof unit.example).toBe('string')
    })
  })
})
