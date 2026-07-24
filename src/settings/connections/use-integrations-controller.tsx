/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo, type Dispatch } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { AppLogo } from '@/components/app-logo'
import type { ToolItem } from '@/components/available-tools'
import { GoogleIcon, MicrosoftIcon } from '@/components/provider-icons'
import { deleteIntegrationCredentials, setIntegrationEnabled, updateSettings } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { useIntegrationStatus } from '@/hooks/use-integration-status'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { useSettings } from '@/hooks/use-settings'
import { configs as googleToolConfigs } from '@/integrations/google/tools'
import { configs as microsoftToolConfigs } from '@/integrations/microsoft/tools'
import { configs as proToolConfigs } from '@/integrations/thunderbolt-pro/tools'
import { getProStatus } from '@/integrations/thunderbolt-pro/utils'
import type { OAuthProvider } from '@/lib/auth'
import type { ConnectionsPageAction } from './page-state'
import type { Integration } from './types'

type IntegrationsControllerOptions = {
  db: AnyDrizzleDatabase
  dispatch: Dispatch<ConnectionsPageAction>
}

const isOAuthProvider = (provider: Integration['provider']): provider is OAuthProvider =>
  provider === 'google' || provider === 'microsoft'

/** Owns integration queries, status derivation, OAuth completion, and mutations. */
export const useIntegrationsController = ({ db, dispatch }: IntegrationsControllerOptions) => {
  const queryClient = useQueryClient()
  const integrationSettings = useSettings({ integrations_pro_is_enabled: false })
  const { data: status, isLoading: isStatusLoading } = useIntegrationStatus()
  const { data: proStatus } = useQuery({ queryKey: ['proStatus'], queryFn: getProStatus })
  const integrationsReady =
    !integrationSettings.integrationsProIsEnabled.isLoading && !isStatusLoading && proStatus !== undefined

  const integrations = useMemo((): Integration[] => {
    const isProUser = proStatus?.isProUser ?? false
    return [
      {
        id: 'thunderbolt',
        name: 'Thunderbolt',
        provider: 'thunderbolt-pro',
        connectLabel: 'Get Pro',
        icon: <AppLogo size={20} />,
        isEnabled: isProUser && integrationSettings.integrationsProIsEnabled.value,
        isConnected: isProUser,
      },
      {
        id: 'google',
        name: 'Google',
        provider: 'google',
        connectLabel: 'Connect Google',
        icon: <GoogleIcon />,
        isEnabled: status?.googleEnabled ?? false,
        isConnected: status?.googleConnected ?? false,
        userEmail: status?.googleEmail ?? undefined,
      },
      {
        id: 'microsoft',
        name: 'Microsoft',
        provider: 'microsoft',
        connectLabel: 'Connect Microsoft',
        icon: <MicrosoftIcon />,
        isEnabled: status?.microsoftEnabled ?? false,
        isConnected: status?.microsoftConnected ?? false,
        userEmail: status?.microsoftEmail ?? undefined,
      },
    ]
  }, [integrationSettings.integrationsProIsEnabled.value, proStatus?.isProUser, status])

  const toolConfigsByProvider: Record<Integration['provider'], { name: string; description: string }[]> = {
    'thunderbolt-pro': proToolConfigs,
    google: googleToolConfigs,
    microsoft: microsoftToolConfigs,
  }

  const toolsFor = (integration: Integration): ToolItem[] => {
    const enabled = integration.isConnected && integration.isEnabled
    return toolConfigsByProvider[integration.provider].map((config) => ({
      name: config.name,
      description: config.description,
      enabled,
    }))
  }

  const { processCallback } = useOAuthConnect({
    onError: (error) => dispatch({ type: 'INTEGRATION_FAILED', error: error.message }),
    returnContext: 'integrations',
  })

  const disconnect = async (integration: Integration) => {
    if (!isOAuthProvider(integration.provider)) {
      return
    }
    try {
      await deleteIntegrationCredentials(db, integration.provider)
      await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
    } catch (error) {
      console.error('Failed to disconnect integration', error)
      dispatch({
        type: 'INTEGRATION_FAILED',
        error: error instanceof Error ? error.message : 'Failed to disconnect integration',
      })
    }
  }

  const toggle = async (integration: Integration, enabled: boolean) => {
    try {
      if (integration.provider === 'thunderbolt-pro') {
        await updateSettings(db, { integrations_pro_is_enabled: enabled.toString() })
      } else {
        await setIntegrationEnabled(db, integration.provider, enabled)
        await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
      }
    } catch (error) {
      console.error('Failed to update integration', error)
      dispatch({
        type: 'INTEGRATION_FAILED',
        error: error instanceof Error ? error.message : 'Failed to update integration',
      })
    }
  }

  // Placeholder until the real upgrade flow exists (billing not built yet).
  // Devs: pro status comes from getProStatus in src/integrations/thunderbolt-pro/utils.ts.
  const getPro = () => {
    alert('Thunderbolt Pro is not available yet. Stay tuned!')
  }

  return { integrations, integrationsReady, toolsFor, processCallback, disconnect, toggle, getPro }
}
