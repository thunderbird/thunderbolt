/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient, type HttpClient } from '@/contexts'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { countryUnitsResponseSchema } from '@/schemas/api'
import type { CountryUnitsData } from '@/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSettings } from './use-settings'

const staleTime = 24 * 60 * 60 * 1000 // 24 hours
const gcTime = 24 * 60 * 60 * 1000 // 24 hours
const retryCount = 2
const retryDelay = 1000 // 1 second

/**
 * Creates a query function for fetching country units data
 * @param targetCountry - Country name or code to fetch units for
 * @param httpClient - HTTP client for making requests
 */
const createCountryUnitsQueryFn =
  (targetCountry: string, httpClient: HttpClient) => async (): Promise<CountryUnitsData> => {
    const response = await httpClient
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
 */
export const useCountryUnits = (country?: string) => {
  const httpClient = useHttpClient()
  const { locationName } = useSettings({
    location_name: '',
  })
  const queryClient = useQueryClient()

  // Use provided country or extract from location_name, fallback to US
  const countryName = country || extractCountryFromLocation(locationName.value || '') || 'US'
  // Part of the key because the response carries display names (currency, unit)
  // and the request sends `X-App-Language`; a 24-hour cache would otherwise
  // outlive a language change. Both keys below must include it, or the
  // imperative fetch writes a cache entry the declarative query never reads.
  const locale = useActiveLocale()

  const query = useQuery({
    queryKey: ['country-units', countryName, locale],
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
        queryKey: ['country-units', targetCountry, locale],
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
