import { getSettings } from '@/dal'
import { countryUnitsResponseSchema } from '@/schemas/api'
import type { CountryUnitsData } from '@/types'
import { useQuery } from '@tanstack/react-query'
import ky from 'ky'
import { useSettings } from './use-settings'

/**
 * Fetches country-specific units data from the backend API
 * Depends on the location settings to get country data. Falls back to US if no country name is found.
 */
export const useCountryUnits = () => {
  const { locationName } = useSettings({
    location_name: '',
  })

  // Extract country name from location_name (last part after comma)
  const countryName = locationName.value ? locationName.value.split(',').pop()?.trim() || 'US' : 'US'

  return useQuery({
    queryKey: ['country-units', countryName],
    queryFn: async (): Promise<CountryUnitsData> => {
      const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
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
