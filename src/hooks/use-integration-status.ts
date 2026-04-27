/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getSettings } from '@/dal'
import { useQuery } from '@tanstack/react-query'

export type IntegrationStatus = {
  googleConnected: boolean
  microsoftConnected: boolean
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
      const { integrationsGoogleCredentials, integrationsMicrosoftCredentials } = await getSettings(db, {
        integrations_google_credentials: '',
        integrations_microsoft_credentials: '',
      })

      const googleConnected = !!integrationsGoogleCredentials && integrationsGoogleCredentials !== ''
      const microsoftConnected = !!integrationsMicrosoftCredentials && integrationsMicrosoftCredentials !== ''

      return {
        googleConnected,
        microsoftConnected,
        availableProviders: {
          google: googleConnected,
          microsoft: microsoftConnected,
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
