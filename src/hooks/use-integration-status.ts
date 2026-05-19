/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getIntegrationStatus } from '@/dal'
import { useQuery } from '@tanstack/react-query'

export type IntegrationStatus = {
  googleConnected: boolean
  googleEnabled: boolean
  googleEmail: string | null
  microsoftConnected: boolean
  microsoftEnabled: boolean
  microsoftEmail: string | null
  availableProviders: {
    google: boolean
    microsoft: boolean
  }
}

export const useIntegrationStatus = (): {
  data: IntegrationStatus | null
  isLoading: boolean
  error: Error | null
} => {
  const db = useDatabase()

  const query = useQuery({
    queryKey: ['integrationStatus'],
    queryFn: async (): Promise<IntegrationStatus> => {
      const status = await getIntegrationStatus(db)

      return {
        ...status,
        availableProviders: {
          google: status.googleConnected,
          microsoft: status.microsoftConnected,
        },
      }
    },
  })

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
