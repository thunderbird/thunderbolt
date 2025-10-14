import { useQuery } from '@tanstack/react-query'
import { getSettings } from '@/lib/dal'
import type { PreferencesSettings } from '@/types'

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
 * Fetches all user preferences settings from the database
 * Acts as the central settings store that other hooks can depend on
 */
export const usePreferencesSettings = () => {
  return useQuery({
    queryKey: ['preferences-settings'],
    queryFn: async (): Promise<PreferencesSettings> => {
      const rawSettings = await getSettings({
        location_name: '',
        location_lat: '',
        location_lng: '',
        preferred_name: '',
        temperature_unit: DEFAULT_IMPERIAL_UNITS.temperature,
        time_format: DEFAULT_IMPERIAL_UNITS.timeFormat,
        distance_unit: 'imperial',
        date_format: 'MM/DD/YYYY',
        currency: 'USD',
        data_collection: true,
        experimental_feature_tasks: false,
      })

      return {
        locationName: rawSettings.location_name,
        locationLat: rawSettings.location_lat,
        locationLng: rawSettings.location_lng,
        preferredName: rawSettings.preferred_name,
        dataCollection: rawSettings.data_collection,
        experimentalFeatureTasks: rawSettings.experimental_feature_tasks,
        temperatureUnit: rawSettings.temperature_unit,
        timeFormat: rawSettings.time_format,
        distanceUnit: rawSettings.distance_unit,
        dateFormat: rawSettings.date_format,
        currency: rawSettings.currency,
        countryName: rawSettings.location_name ? rawSettings.location_name.split(',').pop()?.trim() || null : null,
      }
    },
  })
}
