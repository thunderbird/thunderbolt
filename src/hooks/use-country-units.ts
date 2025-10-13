import { useQuery } from '@tanstack/react-query'
import ky from 'ky'
import type { CountryUnitsData } from '@/types'
import { countryUnitsResponseSchema } from '@/schemas/api'
import { getCloudUrl } from '@/lib/config'

/**
 * Fetches country-specific units data from the backend API
 * @param countryCode - ISO country code (e.g., 'BR', 'US')
 */
export const useCountryUnits = (countryCode: string | null) => {
  return useQuery({
    queryKey: ['country-units', countryCode],
    queryFn: async (): Promise<CountryUnitsData> => {
      if (!countryCode) {
        throw new Error('Country code is required')
      }

      const cloudUrl = await getCloudUrl()
      const response = await ky
        .get(`${cloudUrl}/units`, {
          searchParams: { country: countryCode },
        })
        .json()

      const validatedData = countryUnitsResponseSchema.parse(response)
      return validatedData
    },
    enabled: !!countryCode,
    staleTime: 24 * 60 * 60 * 1000, // 24 hours
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
    retry: 2,
    retryDelay: 1000,
  })
}
