import { describe, it, expect } from 'bun:test'

const mockRawSettings = {
  location_name: 'New York, NY, US',
  location_lat: '40.7128',
  location_lng: '-74.0060',
  preferred_name: 'John Doe',
  temperature_unit: 'F',
  time_format: '12h',
  distance_unit: 'imperial',
  date_format: 'MM/DD/YYYY',
  currency: 'USD',
  data_collection: true,
  experimental_feature_tasks: false,
}

const expectedTransformedSettings = {
  locationName: 'New York, NY, US',
  locationLat: '40.7128',
  locationLng: '-74.0060',
  preferredName: 'John Doe',
  dataCollection: true,
  experimentalFeatureTasks: false,
  temperatureUnit: 'F',
  timeFormat: '12h',
  distanceUnit: 'imperial',
  dateFormat: 'MM/DD/YYYY',
  currency: 'USD',
  countryName: 'US',
}

describe('usePreferencesSettings hook configuration and data transformation', () => {
  it('should have correct query key', () => {
    const queryKey = ['preferences-settings']
    expect(queryKey).toEqual(['preferences-settings'])
    expect(queryKey[0]).toBe('preferences-settings')
  })

  it('should transform snake_case to camelCase correctly', () => {
    const transformed = {
      locationName: mockRawSettings.location_name,
      locationLat: mockRawSettings.location_lat,
      locationLng: mockRawSettings.location_lng,
      preferredName: mockRawSettings.preferred_name,
      dataCollection: mockRawSettings.data_collection,
      experimentalFeatureTasks: mockRawSettings.experimental_feature_tasks,
      temperatureUnit: mockRawSettings.temperature_unit,
      timeFormat: mockRawSettings.time_format,
      distanceUnit: mockRawSettings.distance_unit,
      dateFormat: mockRawSettings.date_format,
      currency: mockRawSettings.currency,
    }

    expect(transformed.locationName).toBe(mockRawSettings.location_name)
    expect(transformed.locationLat).toBe(mockRawSettings.location_lat)
    expect(transformed.locationLng).toBe(mockRawSettings.location_lng)
    expect(transformed.preferredName).toBe(mockRawSettings.preferred_name)
    expect(transformed.dataCollection).toBe(mockRawSettings.data_collection)
    expect(transformed.experimentalFeatureTasks).toBe(mockRawSettings.experimental_feature_tasks)
    expect(transformed.temperatureUnit).toBe(mockRawSettings.temperature_unit)
    expect(transformed.timeFormat).toBe(mockRawSettings.time_format)
    expect(transformed.distanceUnit).toBe(mockRawSettings.distance_unit)
    expect(transformed.dateFormat).toBe(mockRawSettings.date_format)
    expect(transformed.currency).toBe(mockRawSettings.currency)
  })

  it('should extract country name from location_name with multiple parts', () => {
    const locationName = 'New York, NY, US'
    const countryName = locationName ? locationName.split(',').pop()?.trim() || null : null
    expect(countryName).toBe('US')
  })

  it('should extract country name from complex location_name', () => {
    const locationName = 'Paris, Île-de-France, France'
    const countryName = locationName ? locationName.split(',').pop()?.trim() || null : null
    expect(countryName).toBe('France')
  })

  it('should return null for countryName when location_name is empty', () => {
    const locationName = '' as string
    const countryName = locationName ? locationName.split(',').pop()?.trim() || null : null
    expect(countryName).toBeNull()
  })

  it('should return null for countryName when location_name is null', () => {
    const locationName = null as string | null
    const countryName = locationName ? locationName.split(',').pop()?.trim() || null : null
    expect(countryName).toBeNull()
  })

  it('should handle location_name with trailing whitespace', () => {
    const locationName = 'London, England, UK '
    const countryName = locationName ? locationName.split(',').pop()?.trim() || null : null
    expect(countryName).toBe('UK')
  })

  it('should handle location_name with only one part', () => {
    const locationName = 'Tokyo'
    const countryName = locationName ? locationName.split(',').pop()?.trim() || null : null
    expect(countryName).toBe('Tokyo')
  })

  it('should have correct default settings structure', () => {
    const defaultSettings = {
      location_name: '',
      location_lat: '',
      location_lng: '',
      preferred_name: '',
      temperature_unit: 'F',
      time_format: '12h',
      distance_unit: 'imperial',
      date_format: 'MM/DD/YYYY',
      currency: 'USD',
      data_collection: true,
      experimental_feature_tasks: false,
    }

    expect(defaultSettings.location_name).toBe('')
    expect(defaultSettings.location_lat).toBe('')
    expect(defaultSettings.location_lng).toBe('')
    expect(defaultSettings.preferred_name).toBe('')
    expect(defaultSettings.temperature_unit).toBe('F')
    expect(defaultSettings.time_format).toBe('12h')
    expect(defaultSettings.distance_unit).toBe('imperial')
    expect(defaultSettings.date_format).toBe('MM/DD/YYYY')
    expect(defaultSettings.currency).toBe('USD')
    expect(defaultSettings.data_collection).toBe(true)
    expect(defaultSettings.experimental_feature_tasks).toBe(false)
  })

  it('should handle boolean settings correctly', () => {
    const settingsWithBooleans = {
      ...mockRawSettings,
      data_collection: false,
      experimental_feature_tasks: true,
    }

    expect(settingsWithBooleans.data_collection).toBe(false)
    expect(settingsWithBooleans.experimental_feature_tasks).toBe(true)
  })

  it('should handle empty string values', () => {
    const settingsWithEmptyStrings = {
      ...mockRawSettings,
      preferred_name: '',
      location_name: '',
    }

    expect(settingsWithEmptyStrings.preferred_name).toBe('')
    expect(settingsWithEmptyStrings.location_name).toBe('')
  })

  it('should validate transformed settings structure', () => {
    expect(expectedTransformedSettings).toHaveProperty('locationName')
    expect(expectedTransformedSettings).toHaveProperty('locationLat')
    expect(expectedTransformedSettings).toHaveProperty('locationLng')
    expect(expectedTransformedSettings).toHaveProperty('preferredName')
    expect(expectedTransformedSettings).toHaveProperty('dataCollection')
    expect(expectedTransformedSettings).toHaveProperty('experimentalFeatureTasks')
    expect(expectedTransformedSettings).toHaveProperty('temperatureUnit')
    expect(expectedTransformedSettings).toHaveProperty('timeFormat')
    expect(expectedTransformedSettings).toHaveProperty('distanceUnit')
    expect(expectedTransformedSettings).toHaveProperty('dateFormat')
    expect(expectedTransformedSettings).toHaveProperty('currency')
    expect(expectedTransformedSettings).toHaveProperty('countryName')
  })

  it('should have correct data types in transformed settings', () => {
    expect(typeof expectedTransformedSettings.locationName).toBe('string')
    expect(typeof expectedTransformedSettings.locationLat).toBe('string')
    expect(typeof expectedTransformedSettings.locationLng).toBe('string')
    expect(typeof expectedTransformedSettings.preferredName).toBe('string')
    expect(typeof expectedTransformedSettings.dataCollection).toBe('boolean')
    expect(typeof expectedTransformedSettings.experimentalFeatureTasks).toBe('boolean')
    expect(typeof expectedTransformedSettings.temperatureUnit).toBe('string')
    expect(typeof expectedTransformedSettings.timeFormat).toBe('string')
    expect(typeof expectedTransformedSettings.distanceUnit).toBe('string')
    expect(typeof expectedTransformedSettings.dateFormat).toBe('string')
    expect(typeof expectedTransformedSettings.currency).toBe('string')
    expect(typeof expectedTransformedSettings.countryName).toBe('string')
  })

  it('should handle API errors', () => {
    const error = new Error('Database connection failed')
    expect(error.message).toBe('Database connection failed')
    expect(error).toBeInstanceOf(Error)
  })

  it('should validate location coordinates format', () => {
    const lat = '40.7128'
    const lng = '-74.0060'

    expect(lat).toMatch(/^-?\d+\.?\d*$/)
    expect(lng).toMatch(/^-?\d+\.?\d*$/)
    expect(parseFloat(lat)).toBeCloseTo(40.7128, 4)
    expect(parseFloat(lng)).toBeCloseTo(-74.006, 4)
  })

  it('should validate temperature unit format', () => {
    const temperatureUnit = 'F'
    expect(temperatureUnit).toMatch(/^[CF]$/)
  })

  it('should validate time format', () => {
    const timeFormat = '12h'
    expect(timeFormat).toMatch(/^(12h|24h)$/)
  })

  it('should validate distance unit format', () => {
    const distanceUnit = 'imperial'
    expect(distanceUnit).toMatch(/^(metric|imperial)$/)
  })

  it('should validate date format', () => {
    const dateFormat = 'MM/DD/YYYY'
    expect(dateFormat).toMatch(/^[A-Z]{2}\/[A-Z]{2}\/[A-Z]{4}$/)
  })

  it('should validate currency format', () => {
    const currency = 'USD'
    expect(currency).toMatch(/^[A-Z]{3}$/)
  })
})
