import { describe, it, expect } from 'bun:test'
import { localizationFormSchema } from './use-localization-form'
import type { PreferencesSettings } from '@/types'

// Test the schema directly since it contains the core validation logic
describe('useLocalizationForm', () => {
  describe('localizationFormSchema', () => {
    it('should validate valid localization data', () => {
      const validData = {
        temperatureUnit: 'C',
        windSpeedUnit: 'km/h',
        precipitationUnit: 'mm',
        timeFormat: '24h',
        distanceUnit: 'km',
      }

      const result = localizationFormSchema.safeParse(validData)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validData)
      }
    })

    it('should validate with different unit values', () => {
      const validData = {
        temperatureUnit: 'F',
        windSpeedUnit: 'mph',
        precipitationUnit: 'in',
        timeFormat: '12h',
        distanceUnit: 'mi',
      }

      const result = localizationFormSchema.safeParse(validData)
      expect(result.success).toBe(true)
    })

    it('should reject missing required fields', () => {
      const invalidData = {
        temperatureUnit: 'C',
        windSpeedUnit: 'km/h',
      }

      const result = localizationFormSchema.safeParse(invalidData)
      expect(result.success).toBe(false)
    })

    it('should reject non-string values', () => {
      const invalidData = {
        temperatureUnit: 123,
        windSpeedUnit: 'km/h',
        precipitationUnit: 'mm',
        timeFormat: '24h',
        distanceUnit: 'km',
      }

      const result = localizationFormSchema.safeParse(invalidData)
      expect(result.success).toBe(false)
    })

    it('should accept empty strings (validation happens at form level)', () => {
      const validData = {
        temperatureUnit: '',
        windSpeedUnit: '',
        precipitationUnit: '',
        timeFormat: '',
        distanceUnit: '',
      }

      const result = localizationFormSchema.safeParse(validData)
      expect(result.success).toBe(true)
    })

    it('should validate with all possible unit combinations', () => {
      const testCases = [
        {
          temperatureUnit: 'C',
          windSpeedUnit: 'km/h',
          precipitationUnit: 'mm',
          timeFormat: '24h',
          distanceUnit: 'km',
        },
        {
          temperatureUnit: 'F',
          windSpeedUnit: 'mph',
          precipitationUnit: 'in',
          timeFormat: '12h',
          distanceUnit: 'mi',
        },
        {
          temperatureUnit: 'K',
          windSpeedUnit: 'm/s',
          precipitationUnit: 'mm/h',
          timeFormat: 'iso8601',
          distanceUnit: 'm',
        },
      ]

      testCases.forEach((testCase) => {
        const result = localizationFormSchema.safeParse(testCase)
        expect(result.success).toBe(true)
      })
    })

    it('should reject partial data', () => {
      const partialData = {
        temperatureUnit: 'C',
      }

      const result = localizationFormSchema.safeParse(partialData)
      expect(result.success).toBe(false)
    })

    it('should allow extra fields (Zod default behavior)', () => {
      const dataWithExtra = {
        temperatureUnit: 'C',
        windSpeedUnit: 'km/h',
        precipitationUnit: 'mm',
        timeFormat: '24h',
        distanceUnit: 'km',
        extraField: 'should not be here',
      }

      const result = localizationFormSchema.safeParse(dataWithExtra)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).not.toHaveProperty('extraField')
        expect(result.data).toEqual({
          temperatureUnit: 'C',
          windSpeedUnit: 'km/h',
          precipitationUnit: 'mm',
          timeFormat: '24h',
          distanceUnit: 'km',
        })
      }
    })

    it('should handle null and undefined values', () => {
      const nullData = {
        temperatureUnit: null,
        windSpeedUnit: 'km/h',
        precipitationUnit: 'mm',
        timeFormat: '24h',
        distanceUnit: 'km',
      }

      const undefinedData = {
        temperatureUnit: undefined,
        windSpeedUnit: 'km/h',
        precipitationUnit: 'mm',
        timeFormat: '24h',
        distanceUnit: 'km',
      }

      expect(localizationFormSchema.safeParse(nullData).success).toBe(false)
      expect(localizationFormSchema.safeParse(undefinedData).success).toBe(false)
    })
  })

  describe('createFormValues helper function', () => {
    const createFormValues = (settings: PreferencesSettings | undefined, defaultUnits: any) => ({
      temperatureUnit: settings?.temperatureUnit || defaultUnits.temperature,
      windSpeedUnit: settings?.windSpeedUnit || defaultUnits.speed,
      precipitationUnit: settings?.precipitationUnit || defaultUnits.precipitation,
      timeFormat: settings?.timeFormat || defaultUnits.timeFormat,
      distanceUnit: settings?.distanceUnit || defaultUnits.distance,
    })

    const mockDefaultUnits = {
      temperature: 'F',
      speed: 'mph',
      distance: 'mi',
      precipitation: 'in',
      timeFormat: '12h',
    }

    it('should use settings values when available', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        temperatureUnit: 'C',
        windSpeedUnit: 'km/h',
        precipitationUnit: 'mm',
        timeFormat: '24h',
        distanceUnit: 'km',
      }

      const result = createFormValues(settings, mockDefaultUnits)
      expect(result.temperatureUnit).toBe('C')
      expect(result.windSpeedUnit).toBe('km/h')
      expect(result.precipitationUnit).toBe('mm')
      expect(result.timeFormat).toBe('24h')
      expect(result.distanceUnit).toBe('km')
    })

    it('should use default units when settings are undefined', () => {
      const result = createFormValues(undefined, mockDefaultUnits)
      expect(result.temperatureUnit).toBe('F')
      expect(result.windSpeedUnit).toBe('mph')
      expect(result.precipitationUnit).toBe('in')
      expect(result.timeFormat).toBe('12h')
      expect(result.distanceUnit).toBe('mi')
    })

    it('should use default units when settings have empty values', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        temperatureUnit: '',
        windSpeedUnit: '',
        precipitationUnit: '',
        timeFormat: '',
        distanceUnit: '',
      }

      const result = createFormValues(settings, mockDefaultUnits)
      expect(result.temperatureUnit).toBe('F')
      expect(result.windSpeedUnit).toBe('mph')
      expect(result.precipitationUnit).toBe('in')
      expect(result.timeFormat).toBe('12h')
      expect(result.distanceUnit).toBe('mi')
    })

    it('should mix settings and defaults appropriately', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        temperatureUnit: 'C', // Has value
        windSpeedUnit: '', // Empty
        precipitationUnit: 'mm', // Has value
        timeFormat: '', // Empty
        distanceUnit: 'km', // Has value
      }

      const result = createFormValues(settings, mockDefaultUnits)
      expect(result.temperatureUnit).toBe('C')
      expect(result.windSpeedUnit).toBe('mph')
      expect(result.precipitationUnit).toBe('mm')
      expect(result.timeFormat).toBe('12h')
      expect(result.distanceUnit).toBe('km')
    })
  })
})
