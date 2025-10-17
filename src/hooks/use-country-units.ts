import { useQuery, useQueryClient } from '@tanstack/react-query'
import ky from 'ky'
import type { CountryUnitsData } from '@/types'
import { countryUnitsResponseSchema } from '@/schemas/api'
import { getCloudUrl } from '@/lib/config'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { useSettings } from './use-settings'

const STALE_TIME = 24 * 60 * 60 * 1000 // 24 hours
const GC_TIME = 24 * 60 * 60 * 1000 // 24 hours
const RETRY_COUNT = 2
const RETRY_DELAY = 1000 // 1 second

/**
 * Creates a query function for fetching country units data
 */
const createCountryUnitsQueryFn = (targetCountry: string) => async (): Promise<CountryUnitsData> => {
  const cloudUrl = await getCloudUrl()
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
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
    retry: RETRY_COUNT,
    retryDelay: RETRY_DELAY,
  })

  const fetchCountryUnits = async (targetCountry: string): Promise<CountryUnitsData | null> => {
    return await queryClient
      .fetchQuery({
        queryKey: ['country-units', targetCountry],
        queryFn: createCountryUnitsQueryFn(targetCountry),
        staleTime: STALE_TIME,
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
