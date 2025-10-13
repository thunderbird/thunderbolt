import { useQuery } from '@tanstack/react-query'
import ky from 'ky'
import type { CountryUnitsData } from '@/types'
import { countryUnitsResponseSchema } from '@/schemas/api'
import { getCloudUrl } from '@/lib/config'
import { usePreferencesSettings } from './use-preferences-settings'

/**
 * Fetches country-specific units data from the backend API
 * Depends on the preferences settings to get location data. Falls back to US if no country name is found.
 */
export const useCountryUnits = () => {
  const { data: preferencesSettings } = usePreferencesSettings()

  return useQuery({
    queryKey: ['country-units', preferencesSettings?.countryName || 'US'],
    queryFn: async (): Promise<CountryUnitsData> => {
      const countryName = preferencesSettings?.countryName || 'US'

      const cloudUrl = await getCloudUrl()
      const response = await ky
        .get(`${cloudUrl}/units`, {
          searchParams: { country: countryName },
        })
        .json()

      const validatedData = countryUnitsResponseSchema.parse(response)
      return validatedData
    },
    enabled: false,
    refetchOnMount: false,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 2,
    retryDelay: 1000,
  })
}
