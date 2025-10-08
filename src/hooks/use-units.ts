import { useQuery } from '@tanstack/react-query'
import ky from 'ky'
import type { UnitsData } from '@/types'
import { getCloudUrl } from '@/lib/config'

/**
 * Fetches units data from the backend API
 * Results are cached for 24 hours to avoid multiple requests
 */
export const useUnits = () => {
  return useQuery({
    queryKey: ['units'],
    queryFn: async (): Promise<UnitsData> => {
      const cloudUrl = await getCloudUrl()
      const data = await ky.get(`${cloudUrl}/units`).json<UnitsData>()
      return data
    },
    staleTime: 24 * 60 * 60 * 1000, // 24 hours
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
    retry: 2,
    retryDelay: 1000,
  })
}
