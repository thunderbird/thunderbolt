import { getSettings } from '@/dal'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { countryUnitsResponseSchema } from '@/schemas/api'
import type { CountryUnitsData } from '@/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import ky, { type KyInstance } from 'ky'
import { useSettings } from './use-settings'

const staleTime = 24 * 60 * 60 * 1000 // 24 hours
const gcTime = 24 * 60 * 60 * 1000 // 24 hours
const retryCount = 2
const retryDelay = 1000 // 1 second

/**
 * Creates a query function for fetching country units data
 * @param targetCountry - Country name or code to fetch units for
 * @param httpClient - HTTP client for making requests. If not provided, creates a ky instance with cloudUrl from settings as prefixUrl
 */
const createCountryUnitsQueryFn =
  (targetCountry: string, httpClient?: KyInstance) => async (): Promise<CountryUnitsData> => {
    const client =
      httpClient ?? ky.create({ prefixUrl: (await getSettings({ cloud_url: 'http://localhost:8000/v1' })).cloudUrl })
    const response = await client
      .get('units', {
        searchParams: { country: targetCountry },
      })
      .json()
    return countryUnitsResponseSchema.parse(response)
  }

/**
 * Fetches country-specific units data from the backend API
 * Can be used for automatic fetching based on location settings or manual fetching for any country
 * @param country - Optional country name to fetch units for
 * @param httpClient - Optional HTTP client for dependency injection. If not provided, creates a ky instance with cloudUrl from settings as prefixUrl
 */
export const useCountryUnits = (country?: string, httpClient?: KyInstance) => {
  const { locationName } = useSettings({
    location_name: '',
  })
  const queryClient = useQueryClient()

  // Use provided country or extract from location_name, fallback to US
  const countryName = country || extractCountryFromLocation(locationName.value || '') || 'US'

  const query = useQuery({
    queryKey: ['country-units', countryName],
    queryFn: createCountryUnitsQueryFn(countryName, httpClient),
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
        queryFn: createCountryUnitsQueryFn(targetCountry, httpClient),
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
