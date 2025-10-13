import { describe, it, expect } from 'bun:test'
import { localizationFormSchema, createFormValues } from './use-localization-form'
import type { PreferencesSettings } from '@/types'

// Test the schema directly since it contains the core validation logic
describe('useLocalizationForm', () => {
  describe('localizationFormSchema', () => {
    it('should validate valid localization data', () => {
      const validData = {
        distanceUnit: 'metric',
        temperatureUnit: 'C',
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '24h',
        currency: 'BRL',
      }

      const result = localizationFormSchema.safeParse(validData)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validData)
      }
    })

    it('should validate with different unit values', () => {
      const validData = {
        distanceUnit: 'imperial',
        temperatureUnit: 'F',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: '12h',
        currency: 'USD',
      }

      const result = localizationFormSchema.safeParse(validData)
      expect(result.success).toBe(true)
    })

    it('should reject missing required fields', () => {
      const invalidData = {
        distanceUnit: 'metric',
        temperatureUnit: 'C',
      }

      const result = localizationFormSchema.safeParse(invalidData)
      expect(result.success).toBe(false)
    })

    it('should reject non-string values', () => {
      const invalidData = {
        distanceUnit: 123,
        temperatureUnit: 'C',
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '24h',
        currency: 'BRL',
      }

      const result = localizationFormSchema.safeParse(invalidData)
      expect(result.success).toBe(false)
    })

    it('should accept empty strings (validation happens at form level)', () => {
      const validData = {
        distanceUnit: '',
        temperatureUnit: '',
        dateFormat: '',
        timeFormat: '',
        currency: '',
      }

      const result = localizationFormSchema.safeParse(validData)
      expect(result.success).toBe(true)
    })

    it('should validate with all possible unit combinations', () => {
      const testCases = [
        {
          distanceUnit: 'metric',
          temperatureUnit: 'C',
          dateFormat: 'DD/MM/YYYY',
          timeFormat: '24h',
          currency: 'BRL',
        },
        {
          distanceUnit: 'imperial',
          temperatureUnit: 'F',
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
          currency: 'USD',
        },
        {
          distanceUnit: 'metric',
          temperatureUnit: 'C',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '24h',
          currency: 'EUR',
        },
      ]

      testCases.forEach((testCase) => {
        const result = localizationFormSchema.safeParse(testCase)
        expect(result.success).toBe(true)
      })
    })

    it('should reject partial data', () => {
      const partialData = {
        distanceUnit: 'metric',
      }

      const result = localizationFormSchema.safeParse(partialData)
      expect(result.success).toBe(false)
    })

    it('should allow extra fields (Zod default behavior)', () => {
      const dataWithExtra = {
        distanceUnit: 'metric',
        temperatureUnit: 'C',
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '24h',
        currency: 'BRL',
        extraField: 'should not be here',
      }

      const result = localizationFormSchema.safeParse(dataWithExtra)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).not.toHaveProperty('extraField')
        expect(result.data).toEqual({
          distanceUnit: 'metric',
          temperatureUnit: 'C',
          dateFormat: 'DD/MM/YYYY',
          timeFormat: '24h',
          currency: 'BRL',
        })
      }
    })

    it('should handle null and undefined values', () => {
      const nullData = {
        distanceUnit: 'metric',
        temperatureUnit: null,
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '24h',
        currency: 'BRL',
      }

      const undefinedData = {
        distanceUnit: 'metric',
        temperatureUnit: undefined,
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '24h',
        currency: 'BRL',
      }

      expect(localizationFormSchema.safeParse(nullData).success).toBe(false)
      expect(localizationFormSchema.safeParse(undefinedData).success).toBe(false)
    })
  })

  describe('createFormValues helper function', () => {
    const mockCountryUnitsData = {
      units: 'metric',
      temperature: 'C',
      timeFormat: '24',
      dateFormatExample: 'DD/MM/YYYY',
      currency: { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
    }

    it('should use settings values when available', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        distanceUnit: 'imperial',
        temperatureUnit: 'F',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: '12h',
        currency: 'USD',
      }

      const result = createFormValues(settings, mockCountryUnitsData)
      expect(result.distanceUnit).toBe('imperial')
      expect(result.temperatureUnit).toBe('F')
      expect(result.dateFormat).toBe('MM/DD/YYYY')
      expect(result.timeFormat).toBe('12h')
      expect(result.currency).toBe('USD')
    })

    it('should use country units data when settings are undefined', () => {
      const result = createFormValues(undefined, mockCountryUnitsData)
      expect(result.distanceUnit).toBe('metric')
      expect(result.temperatureUnit).toBe('C')
      expect(result.dateFormat).toBe('DD/MM/YYYY')
      expect(result.timeFormat).toBe('24')
      expect(result.currency).toBe('BRL')
    })

    it('should use country units data when settings have empty values', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        distanceUnit: '',
        temperatureUnit: '',
        dateFormat: '',
        timeFormat: '',
        currency: '',
      }

      const result = createFormValues(settings, mockCountryUnitsData)
      expect(result.distanceUnit).toBe('metric')
      expect(result.temperatureUnit).toBe('C')
      expect(result.dateFormat).toBe('DD/MM/YYYY')
      expect(result.timeFormat).toBe('24')
      expect(result.currency).toBe('BRL')
    })

    it('should mix settings and country units data appropriately', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        distanceUnit: 'imperial',
        temperatureUnit: '',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: '',
        currency: 'USD',
      }

      const result = createFormValues(settings, mockCountryUnitsData)
      expect(result.distanceUnit).toBe('imperial')
      expect(result.temperatureUnit).toBe('C')
      expect(result.dateFormat).toBe('MM/DD/YYYY')
      expect(result.timeFormat).toBe('24')
      expect(result.currency).toBe('USD')
    })

    it('should use US defaults when no country data is available', () => {
      const result = createFormValues(undefined, undefined)
      expect(result.distanceUnit).toBe('imperial')
      expect(result.temperatureUnit).toBe('F')
      expect(result.dateFormat).toBe('MM/DD/YYYY')
      expect(result.timeFormat).toBe('12')
      expect(result.currency).toBe('USD')
    })

    it('should prioritize country data when prioritizeCountryData is true', () => {
      const settings: PreferencesSettings = {
        locationName: 'Test',
        locationLat: '0',
        locationLng: '0',
        preferredName: 'Test',
        dataCollection: true,
        experimentalFeatureTasks: false,
        distanceUnit: 'imperial',
        temperatureUnit: 'F',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: '12',
        currency: 'USD',
      }

      const result = createFormValues(settings, mockCountryUnitsData, true)
      expect(result.distanceUnit).toBe('metric')
      expect(result.temperatureUnit).toBe('C')
      expect(result.dateFormat).toBe('DD/MM/YYYY')
      expect(result.timeFormat).toBe('24')
      expect(result.currency).toBe('BRL')
    })
  })
})
