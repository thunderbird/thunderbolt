import { AvailableTools } from '@/components/available-tools'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { ConnectProviderButton } from '@/components/connect-provider-button'
import { GoogleIcon, MicrosoftIcon } from '@/components/provider-icons'
import { configs as googleToolConfigs } from '@/integrations/google/tools'
import { configs as microsoftToolConfigs } from '@/integrations/microsoft/tools'
import { configs as proToolConfigs } from '@/integrations/thunderbolt-pro/tools'
import { getProStatus } from '@/integrations/thunderbolt-pro/utils'
import { type OAuthProvider } from '@/lib/auth'
import { updateSettings } from '@/dal'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { shouldInvalidateSettingsSubset, useSettings } from '@/hooks/use-settings'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'

type Integration = {
  id: string
  name: string
  provider: string
  connectLabel: string
  icon: ReactNode
  isEnabled: boolean
  isConnected: boolean
  userEmail?: string
  credentials?: {
    access_token: string
    refresh_token: string
    expires_at: number
    profile?: {
      email?: string
      name?: string
    }
  }
}

const ThunderboltProIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 2L3 12h7l-2 8 10-10h-7l2-8z" fill="currentColor" className="text-amber-500" />
  </svg>
)

const integrationSettingsKeys = [
  'integrations_pro_is_enabled',
  'integrations_google_is_enabled',
  'integrations_google_credentials',
  'integrations_microsoft_is_enabled',
  'integrations_microsoft_credentials',
] as const

const parseCredentials = (credentialsJson: string): Integration['credentials'] | undefined => {
  if (!credentialsJson) return undefined
  try {
    return JSON.parse(credentialsJson) as Integration['credentials']
  } catch (e) {
    console.error('Failed to parse credentials:', e)
    return undefined
  }
}

export default function IntegrationsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [error, setError] = useState<string | null>(null)
  const [isProcessingCallback, setIsProcessingCallback] = useState(() => {
    const oauth = (location.state as { oauth?: unknown } | null)?.oauth
    return !!oauth
  })

  const integrationSettings = useSettings({
    integrations_pro_is_enabled: false,
    integrations_google_is_enabled: false,
    integrations_google_credentials: '',
    integrations_microsoft_is_enabled: false,
    integrations_microsoft_credentials: '',
  })

  const { data: proStatus, isLoading: proStatusLoading } = useQuery({
    queryKey: ['proStatus'],
    queryFn: getProStatus,
  })

  const integrations = useMemo((): Integration[] => {
    const proEnabled = integrationSettings.integrationsProIsEnabled.value
    const googleEnabled = integrationSettings.integrationsGoogleIsEnabled.value
    const googleCredentials = integrationSettings.integrationsGoogleCredentials.value ?? ''
    const microsoftEnabled = integrationSettings.integrationsMicrosoftIsEnabled.value
    const microsoftCredentials = integrationSettings.integrationsMicrosoftCredentials.value ?? ''

    const gParsed = parseCredentials(googleCredentials)
    const mParsed = parseCredentials(microsoftCredentials)
    const isProUser = proStatus?.isProUser ?? false

    return [
      {
        id: 'thunderbolt-pro',
        name: 'Thunderbolt Pro',
        provider: 'thunderbolt-pro',
        connectLabel: 'Get Pro',
        icon: <ThunderboltProIcon />,
        isEnabled: isProUser && proEnabled,
        isConnected: isProUser,
        userEmail: isProUser ? 'Thunderbolt Pro' : undefined,
      },
      {
        id: 'google',
        name: 'Google',
        provider: 'google',
        connectLabel: 'Connect Google',
        icon: <GoogleIcon />,
        isEnabled: googleEnabled,
        isConnected: !!gParsed,
        userEmail: gParsed?.profile?.email,
        credentials: gParsed,
      },
      {
        id: 'microsoft',
        name: 'Microsoft',
        provider: 'microsoft',
        connectLabel: 'Connect Microsoft',
        icon: <MicrosoftIcon />,
        isEnabled: microsoftEnabled,
        isConnected: !!mParsed,
        userEmail: mParsed?.profile?.email,
        credentials: mParsed,
      },
    ]
  }, [
    integrationSettings.integrationsProIsEnabled.value,
    integrationSettings.integrationsGoogleIsEnabled.value,
    integrationSettings.integrationsGoogleCredentials.value,
    integrationSettings.integrationsMicrosoftIsEnabled.value,
    integrationSettings.integrationsMicrosoftCredentials.value,
    proStatus?.isProUser,
  ])

  const invalidateIntegrationSettings = () => {
    for (const key of integrationSettingsKeys) {
      queryClient.invalidateQueries({
        predicate: (query) => shouldInvalidateSettingsSubset(query, key),
      })
    }
  }

  const { processCallback } = useOAuthConnect({
    onSuccess: invalidateIntegrationSettings,
    onError: (err) => {
      setError(err.message)
    },
    returnContext: 'integrations',
  })

  // Handle OAuth callback when navigated back from /oauth/callback
  useEffect(() => {
    const oauth = (location.state as { oauth?: { code?: string; state?: string; error?: string } } | null)?.oauth
    if (!oauth) return

    const handleCallback = async () => {
      setIsProcessingCallback(true)
      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        setIsProcessingCallback(false)
        navigate('.', { replace: true, state: null })
      }
    }

    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const handleGetPro = async () => {
    // For now, just show an alert since this is a placeholder
    alert(
      'Thunderbolt Pro upgrade would be handled here. For testing, toggle the IS_PRO_USER constant in src/integrations/thunderbolt-pro/utils.ts',
    )
  }

  const handleDisconnect = async (integration: Integration) => {
    try {
      await updateSettings({
        [`integrations_${integration.provider}_credentials`]: '',
        [`integrations_${integration.provider}_is_enabled`]: 'false',
      })
      invalidateIntegrationSettings()
    } catch (err) {
      console.error('Failed to disconnect integration', err)
    }
  }

  const handleToggleEnabled = async (integration: Integration, enabled: boolean) => {
    try {
      const settingKey =
        integration.provider === 'thunderbolt-pro'
          ? 'integrations_pro_is_enabled'
          : `integrations_${integration.provider}_is_enabled`
      await updateSettings({ [settingKey]: enabled.toString() })
      queryClient.invalidateQueries({
        predicate: (query) => shouldInvalidateSettingsSubset(query, settingKey),
      })
    } catch (err) {
      console.error('Failed to update integration', err)
    }
  }

  const loading = integrationSettings.integrationsProIsEnabled.isLoading || proStatusLoading

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-muted-foreground">Loading integrations...</div>
      </div>
    )
  }

  return (
    <div className="max-w-[760px] mx-auto p-4 pb-12 flex flex-col gap-6">
      <PageHeader title="Integrations" />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4">
        {integrations.map((integration) => (
          <Card key={integration.id} className="border border-border shadow-sm">
            <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0 py-2">
              <div className="flex items-center gap-2">
                {integration.icon}
                <CardTitle className="text-base">
                  {integration.isConnected && integration.userEmail ? integration.userEmail : integration.name}
                </CardTitle>
              </div>

              <CardAction className="flex items-center gap-2">
                <Switch
                  checked={integration.isEnabled}
                  onCheckedChange={(checked) => handleToggleEnabled(integration, checked)}
                  disabled={!integration.isConnected}
                />
              </CardAction>
            </CardHeader>

            {!integration.isConnected && (
              <CardContent>
                {integration.provider === 'thunderbolt-pro' ? (
                  <Button onClick={handleGetPro} className="w-full">
                    {integration.connectLabel}
                  </Button>
                ) : (
                  <ConnectProviderButton
                    provider={integration.provider as OAuthProvider}
                    isConnected={false}
                    isProcessing={isProcessingCallback}
                    onSuccess={invalidateIntegrationSettings}
                    onError={(error) => {
                      setError(error.message)
                    }}
                    returnContext="integrations"
                    className="w-full"
                    connectLabel={integration.connectLabel}
                  />
                )}
              </CardContent>
            )}

            {integration.isConnected && integration.isEnabled && integration.provider === 'thunderbolt-pro' && (
              <CardContent className="border-t pt-0">
                <AvailableTools
                  className="pt-4"
                  tools={proToolConfigs.map((config) => ({
                    name: config.name,
                    description: config.description,
                  }))}
                />
              </CardContent>
            )}

            {integration.isConnected && integration.isEnabled && integration.provider === 'google' && (
              <CardContent className="border-t pt-0">
                <AvailableTools
                  className="pt-4"
                  tools={googleToolConfigs.map((config) => ({
                    name: config.name,
                    description: config.description,
                  }))}
                />
              </CardContent>
            )}

            {integration.isConnected && integration.isEnabled && integration.provider === 'microsoft' && (
              <CardContent className="border-t pt-0">
                <AvailableTools
                  className="pt-4"
                  tools={microsoftToolConfigs.map((config) => ({
                    name: config.name,
                    description: config.description,
                  }))}
                />
              </CardContent>
            )}

            {/* If the account is connected but the integration is disabled, we still want the visual divider */}
            {integration.isConnected && !integration.isEnabled && integration.provider !== 'thunderbolt-pro' && (
              <CardContent className="border-t p-0" />
            )}

            {integration.isConnected && integration.provider !== 'thunderbolt-pro' && (
              <CardFooter>
                <Button variant="outline" size="sm" onClick={() => handleDisconnect(integration)} className="ml-auto">
                  Disconnect
                </Button>
              </CardFooter>
            )}
          </Card>
        ))}

        {integrations.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25 shadow-none">
            <CardContent className="flex flex-col items-center justify-center py-8">
              <div className="text-muted-foreground text-center">
                <p className="mb-2">No integrations available</p>
                <p className="text-sm">Check back later for new integrations</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
