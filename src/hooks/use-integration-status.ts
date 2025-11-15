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
  const query = useQuery({
    queryKey: ['integrationStatus'],
    queryFn: async (): Promise<IntegrationStatus> => {
      const { integrationsGoogleCredentials, integrationsMicrosoftCredentials } = await getSettings({
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
