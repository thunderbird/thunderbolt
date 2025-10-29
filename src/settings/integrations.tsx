import { AvailableTools } from '@/components/available-tools'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { ConnectProviderButton } from '@/components/connect-provider-button'
import { configs as googleToolConfigs } from '@/integrations/google/tools'
import { configs as microsoftToolConfigs } from '@/integrations/microsoft/tools'
import { configs as proToolConfigs } from '@/integrations/thunderbolt-pro/tools'
import { getProStatus } from '@/integrations/thunderbolt-pro/utils'
import { type OAuthProvider } from '@/lib/auth'
import { getSettings, updateSetting } from '@/dal'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { useEffect, useState, type ReactNode } from 'react'
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

const GoogleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="#EA4335"
    />
  </svg>
)

const MicrosoftIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 0h11.377v11.372H0V0z" fill="#F25022" />
    <path d="M12.623 0H24v11.372H12.623V0z" fill="#7FBA00" />
    <path d="M0 12.628h11.377V24H0V12.628z" fill="#00A4EF" />
    <path d="M12.623 12.628H24V24H12.623V12.628z" fill="#FFB900" />
  </svg>
)

const ThunderboltProIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 2L3 12h7l-2 8 10-10h-7l2-8z" fill="currentColor" className="text-amber-500" />
  </svg>
)

export default function IntegrationsPage() {
  const location = useLocation()
  const navigate = useNavigate()

  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { processCallback } = useOAuthConnect({
    onSuccess: () => {
      loadIntegrations()
    },
    onError: (error) => {
      setError(error.message)
    },
    returnContext: 'integrations',
  })

  useEffect(() => {
    loadIntegrations()
  }, [])

  // Handle OAuth callback when navigated back from /oauth/callback
  useEffect(() => {
    const oauth = (location.state as any)?.oauth
    if (!oauth) return

    const handleCallback = async () => {
      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        navigate('.', { replace: true, state: null })
      }
    }

    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const loadIntegrations = async () => {
    setLoading(true)
    try {
      // Fetch all integration settings in a single query (returns camelCase by default)
      const {
        integrationsProIsEnabled,
        integrationsGoogleIsEnabled,
        integrationsGoogleCredentials,
        integrationsMicrosoftIsEnabled,
        integrationsMicrosoftCredentials,
      } = await getSettings({
        integrations_pro_is_enabled: false,
        integrations_google_is_enabled: false,
        integrations_google_credentials: '',
        integrations_microsoft_is_enabled: false,
        integrations_microsoft_credentials: '',
      })

      // Thunderbolt Pro integration ----------------------------------------
      const proStatus = await getProStatus()

      let gParsedCredentials: any = null
      let gUserEmail: string | undefined = undefined

      if (integrationsGoogleCredentials) {
        try {
          gParsedCredentials = JSON.parse(integrationsGoogleCredentials)
          gUserEmail = gParsedCredentials.profile?.email
        } catch (e) {
          console.error('Failed to parse Google credentials:', e)
        }
      }

      let mParsedCredentials: any = null
      let mUserEmail: string | undefined = undefined

      if (integrationsMicrosoftCredentials) {
        try {
          mParsedCredentials = JSON.parse(integrationsMicrosoftCredentials)
          mUserEmail = mParsedCredentials.profile?.email
        } catch (e) {
          console.error('Failed to parse Microsoft credentials:', e)
        }
      }

      const integrations = [
        {
          id: 'thunderbolt-pro',
          name: 'Thunderbolt Pro',
          provider: 'thunderbolt-pro',
          connectLabel: 'Get Pro',
          icon: <ThunderboltProIcon />,
          isEnabled: proStatus.isProUser && integrationsProIsEnabled,
          isConnected: proStatus.isProUser,
          userEmail: proStatus.isProUser ? 'Thunderbolt Pro' : undefined,
        },
        {
          id: 'google',
          name: 'Google',
          provider: 'google',
          connectLabel: 'Connect Google',
          icon: <GoogleIcon />,
          isEnabled: integrationsGoogleIsEnabled,
          isConnected: !!gParsedCredentials,
          userEmail: gUserEmail,
          credentials: gParsedCredentials,
        },
        {
          id: 'microsoft',
          name: 'Microsoft',
          provider: 'microsoft',
          connectLabel: 'Connect Microsoft',
          icon: <MicrosoftIcon />,
          isEnabled: integrationsMicrosoftIsEnabled,
          isConnected: !!mParsedCredentials,
          userEmail: mUserEmail,
          credentials: mParsedCredentials,
        },
      ]

      setIntegrations(integrations)
    } catch (error) {
      console.error('Failed to load integrations:', error)
      console.error('Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }

  const handleGetPro = async () => {
    // For now, just show an alert since this is a placeholder
    alert(
      'Thunderbolt Pro upgrade would be handled here. For testing, toggle the IS_PRO_USER constant in src/integrations/thunderbolt-pro/utils.ts',
    )
  }

  const handleDisconnect = async (integration: Integration) => {
    try {
      await updateSetting(`integrations_${integration.provider}_credentials`, '')
      await updateSetting(`integrations_${integration.provider}_is_enabled`, 'false')

      console.log(`Disconnected from ${integration.name}`)

      await loadIntegrations()
    } catch (error) {
      console.error('Failed to disconnect integration', error)
    }
  }

  const handleToggleEnabled = async (integration: Integration, enabled: boolean) => {
    try {
      // Use shorter setting key for thunderbolt-pro
      const settingKey =
        integration.provider === 'thunderbolt-pro'
          ? 'integrations_pro_is_enabled'
          : `integrations_${integration.provider}_is_enabled`

      await updateSetting(settingKey, enabled.toString())

      setIntegrations((prev) => prev.map((i) => (i.id === integration.id ? { ...i, isEnabled: enabled } : i)))

      console.log(`${integration.name} integration ${enabled ? 'enabled' : 'disabled'}`)
    } catch (error) {
      console.error('Failed to update integration', error)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-muted-foreground">Loading integrations...</div>
      </div>
    )
  }

  return (
    <div className="max-w-[760px] mx-auto p-4 pb-12">
      <div className="mb-6">
        <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Integrations</h1>
      </div>

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
                    onSuccess={() => {
                      loadIntegrations()
                    }}
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
