export type UnitSystem = 'metric' | 'imperial'

/**
 * Default units for imperial system (US fallback)
 */
export const DEFAULT_IMPERIAL_UNITS = {
  temperature: 'F',
  speed: 'mph',
  distance: 'mi',
  precipitation: 'in',
  timeFormat: '12h',
} as const

/**
 * Default units for metric system
 */
export const DEFAULT_METRIC_UNITS = {
  temperature: 'C',
  speed: 'km/h',
  distance: 'km',
  precipitation: 'mm',
  timeFormat: '24h',
} as const

/**
 * Detects the user's preferred unit system based on OS settings
 * Falls back to imperial system (US) if detection fails
 */
export const detectUnitSystem = async (): Promise<UnitSystem> => {
  try {
    // Use browser locale detection (works for both Tauri and web)
    const browserLocale = navigator.language || navigator.languages?.[0] || 'en-US'
    const countryCode = browserLocale.split('-').pop()?.toUpperCase()

    const imperialCountries = [
      'US',
      'LR',
      'MM', // United States, Liberia, Myanmar
    ]

    if (countryCode && imperialCountries.includes(countryCode)) {
      return 'imperial'
    }

    return 'metric'
  } catch (error) {
    console.warn('Failed to detect unit system, defaulting to imperial (US):', error)
    return 'imperial'
  }
}

/**
 * Gets default units based on detected unit system
 */
export const getDefaultUnits = (unitSystem: UnitSystem) => {
  return unitSystem === 'imperial' ? DEFAULT_IMPERIAL_UNITS : DEFAULT_METRIC_UNITS
}
