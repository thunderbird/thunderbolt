import { useQuery } from '@tanstack/react-query'
import ky from 'ky'
import type { UnitsOptionsData } from '@/types'
import { unitsOptionsResponseSchema } from '@/schemas/api'
import { getCloudUrl } from '@/lib/config'

/**
 * Fetches units options data from the backend API
 * Results are cached for 24 hours to avoid multiple requests
 */
export const useUnitsOptions = () => {
  return useQuery({
    queryKey: ['units-options'],
    queryFn: async (): Promise<UnitsOptionsData> => {
      const cloudUrl = await getCloudUrl()
      const response = await ky.get(`${cloudUrl}/units-options`).json()

      const validatedData = unitsOptionsResponseSchema.parse(response)
      return validatedData
    },
    staleTime: 24 * 60 * 60 * 1000, // 24 hours
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
    retry: 2,
    retryDelay: 1000,
  })
}
