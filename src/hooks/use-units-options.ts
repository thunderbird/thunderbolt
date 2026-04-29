/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts/http-client-context'
import { unitsOptionsResponseSchema } from '@/schemas/api'
import type { UnitsOptionsData } from '@/types'
import { useQuery } from '@tanstack/react-query'

/**
 * Fetches units options data from the backend API
 * Results are cached for 24 hours to avoid multiple requests
 */
export const useUnitsOptions = () => {
  const httpClient = useHttpClient()

  return useQuery({
    queryKey: ['units-options'],
    queryFn: async (): Promise<UnitsOptionsData> => {
      const response = await httpClient.get('units-options').json()
      const validatedData = unitsOptionsResponseSchema.parse(response)
      return validatedData
    },
    staleTime: 24 * 60 * 60 * 1000, // 24 hours
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
    retry: 2,
    retryDelay: 1000,
  })
}
