import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test'
import { detectUnitSystem, getDefaultUnits, DEFAULT_IMPERIAL_UNITS, DEFAULT_METRIC_UNITS } from './unit-detection'

describe('unit-detection', () => {
  let originalNavigator: Navigator

  beforeEach(() => {
    // Store original navigator
    originalNavigator = global.navigator
  })

  afterEach(() => {
    // Restore original navigator
    global.navigator = originalNavigator
    vi.restoreAllMocks()
  })

  describe('detectUnitSystem', () => {
    it('should return imperial for US locale', async () => {
      global.navigator = {
        language: 'en-US',
        languages: ['en-US', 'en'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial')
    })

    it('should return imperial for Liberia locale', async () => {
      global.navigator = {
        language: 'en-LR',
        languages: ['en-LR'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial')
    })

    it('should return imperial for Myanmar locale', async () => {
      global.navigator = {
        language: 'my-MM',
        languages: ['my-MM'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial')
    })

    it('should return metric for non-imperial countries', async () => {
      const testCases = [
        'en-GB', // United Kingdom
        'pt-BR', // Brazil
        'de-DE', // Germany
        'fr-FR', // France
        'ja-JP', // Japan
        'zh-CN', // China
        'es-ES', // Spain
        'it-IT', // Italy
        'nl-NL', // Netherlands
        'sv-SE', // Sweden
      ]

      for (const locale of testCases) {
        global.navigator = {
          language: locale,
          languages: [locale],
        } as Navigator

        const result = await detectUnitSystem()
        expect(result).toBe('metric')
      }
    })

    it('should return metric for locales without country code', async () => {
      global.navigator = {
        language: 'en',
        languages: ['en'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('metric')
    })

    it('should return metric for invalid locale format', async () => {
      global.navigator = {
        language: 'invalid-locale-format',
        languages: ['invalid-locale-format'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('metric')
    })

    it('should fallback to first language from languages array when language is missing', async () => {
      global.navigator = {
        language: undefined,
        languages: ['en-US', 'en-GB', 'en'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial') // Should use en-US from languages array
    })

    it('should handle missing navigator.language', async () => {
      global.navigator = {
        language: undefined,
        languages: ['en-US'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial')
    })

    it('should handle missing navigator.languages', async () => {
      global.navigator = {
        language: 'en-US',
        languages: undefined,
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial')
    })

    it('should handle completely missing navigator', async () => {
      // @ts-expect-error - Testing error case
      global.navigator = undefined

      const result = await detectUnitSystem()
      expect(result).toBe('imperial') // Should fallback to imperial
    })

    it('should handle navigator with no language properties', async () => {
      global.navigator = {} as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial') // Should fallback to imperial
    })

    it('should handle case insensitive country codes', async () => {
      global.navigator = {
        language: 'en-us', // lowercase
        languages: ['en-us'],
      } as Navigator

      const result = await detectUnitSystem()
      expect(result).toBe('imperial')
    })
  })

  describe('getDefaultUnits', () => {
    it('should return imperial units for imperial system', () => {
      const result = getDefaultUnits('imperial')
      expect(result).toEqual(DEFAULT_IMPERIAL_UNITS)
    })

    it('should return metric units for metric system', () => {
      const result = getDefaultUnits('metric')
      expect(result).toEqual(DEFAULT_METRIC_UNITS)
    })

    it('should have correct imperial unit values', () => {
      const imperialUnits = getDefaultUnits('imperial')
      expect(imperialUnits.temperature).toBe('F')
      expect(imperialUnits.speed).toBe('mph')
      expect(imperialUnits.distance).toBe('mi')
      expect(imperialUnits.precipitation).toBe('in')
      expect(imperialUnits.timeFormat).toBe('12h')
    })

    it('should have correct metric unit values', () => {
      const metricUnits = getDefaultUnits('metric')
      expect(metricUnits.temperature).toBe('C')
      expect(metricUnits.speed).toBe('km/h')
      expect(metricUnits.distance).toBe('km')
      expect(metricUnits.precipitation).toBe('mm')
      expect(metricUnits.timeFormat).toBe('24h')
    })
  })

  describe('DEFAULT_IMPERIAL_UNITS', () => {
    it('should have all required properties', () => {
      expect(DEFAULT_IMPERIAL_UNITS).toHaveProperty('temperature')
      expect(DEFAULT_IMPERIAL_UNITS).toHaveProperty('speed')
      expect(DEFAULT_IMPERIAL_UNITS).toHaveProperty('distance')
      expect(DEFAULT_IMPERIAL_UNITS).toHaveProperty('precipitation')
      expect(DEFAULT_IMPERIAL_UNITS).toHaveProperty('timeFormat')
    })

    it('should have non-empty string values', () => {
      Object.values(DEFAULT_IMPERIAL_UNITS).forEach((value) => {
        expect(typeof value).toBe('string')
        expect(value.length).toBeGreaterThan(0)
      })
    })
  })

  describe('DEFAULT_METRIC_UNITS', () => {
    it('should have all required properties', () => {
      expect(DEFAULT_METRIC_UNITS).toHaveProperty('temperature')
      expect(DEFAULT_METRIC_UNITS).toHaveProperty('speed')
      expect(DEFAULT_METRIC_UNITS).toHaveProperty('distance')
      expect(DEFAULT_METRIC_UNITS).toHaveProperty('precipitation')
      expect(DEFAULT_METRIC_UNITS).toHaveProperty('timeFormat')
    })

    it('should have non-empty string values', () => {
      Object.values(DEFAULT_METRIC_UNITS).forEach((value) => {
        expect(typeof value).toBe('string')
        expect(value.length).toBeGreaterThan(0)
      })
    })
  })
})
