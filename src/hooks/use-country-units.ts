import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSettings } from '@/dal'
import ky from 'ky'
import type { CountryUnitsData } from '@/types'
import { countryUnitsResponseSchema } from '@/schemas/api'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { useSettings } from './use-settings'

const staleTime = 24 * 60 * 60 * 1000 // 24 hours
const gcTime = 24 * 60 * 60 * 1000 // 24 hours
const retryCount = 2
const retryDelay = 1000 // 1 second

/**
 * Creates a query function for fetching country units data
 */
const createCountryUnitsQueryFn = (targetCountry: string) => async (): Promise<CountryUnitsData> => {
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  const response = await ky
    .get(`${cloudUrl}/units`, {
      searchParams: { country: targetCountry },
    })
    .json()
  return countryUnitsResponseSchema.parse(response)
}

/**
 * Fetches country-specific units data from the backend API
 * Can be used for automatic fetching based on location settings or manual fetching for any country
 */
export const useCountryUnits = (country?: string) => {
  const { locationName } = useSettings({
    location_name: '',
  })
  const queryClient = useQueryClient()

  // Use provided country or extract from location_name, fallback to US
  const countryName = country || extractCountryFromLocation(locationName.value || '') || 'US'

  const query = useQuery({
    queryKey: ['country-units', countryName],
    queryFn: createCountryUnitsQueryFn(countryName),
    enabled: false,
    refetchOnMount: false,
    staleTime: staleTime,
    gcTime: gcTime,
    retry: retryCount,
    retryDelay: retryDelay,
  })

  const fetchCountryUnits = async (targetCountry: string): Promise<CountryUnitsData | null> => {
    return await queryClient
      .fetchQuery({
        queryKey: ['country-units', targetCountry],
        queryFn: createCountryUnitsQueryFn(targetCountry),
        staleTime: staleTime,
      })
      .catch((error) => {
        console.error('Error fetching country units:', error)
        return null
      })
  }

  return {
    ...query,
    fetchCountryUnits,
  }
}
