import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  GmailIcon,
  GoogleCalendarIcon,
  GoogleIcon,
  MicrosoftCalendarIcon,
  MicrosoftIcon,
  OutlookIcon,
} from '@/components/provider-icons'
import { getSettings } from '@/dal'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { Check } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

type ConnectIntegrationWidgetProps = {
  provider?: 'google' | 'microsoft'
  service: 'email' | 'calendar' | 'both'
  reason?: string
  messageId: string
}

const getProviderName = (provider: 'google' | 'microsoft'): string => {
  return provider === 'google' ? 'Google' : 'Microsoft'
}

const getServiceName = (service: 'email' | 'calendar' | 'both'): string => {
  switch (service) {
    case 'email':
      return 'Email'
    case 'calendar':
      return 'Calendar'
    case 'both':
      return 'Email and Calendar'
  }
}

const getIconComponent = (provider: 'google' | 'microsoft', service: 'email' | 'calendar' | 'both') => {
  if (service === 'email') {
    return provider === 'google' ? GmailIcon : OutlookIcon
  }
  if (service === 'calendar') {
    return provider === 'google' ? GoogleCalendarIcon : MicrosoftCalendarIcon
  }
  // service === 'both'
  return provider === 'google' ? GoogleIcon : MicrosoftIcon
}

const getDefaultReason = (service: 'email' | 'calendar' | 'both'): string => {
  const serviceName = getServiceName(service)
  return `to access your ${serviceName.toLowerCase()}`
}

/**
 * Widget that prompts users to connect their email/calendar accounts
 */
export const ConnectIntegrationWidget = memo(
  ({ provider, service, reason, messageId }: ConnectIntegrationWidgetProps) => {
    const location = useLocation()
    const navigate = useNavigate()
    const [isConnecting, setIsConnecting] = useState(false)
    const [isDismissed, setIsDismissed] = useState(false)
    const [isConnected, setIsConnected] = useState(false)
    const [connectedProvider, setConnectedProvider] = useState<'google' | 'microsoft' | null>(null)
    const [availableProviders, setAvailableProviders] = useState<{
      google: boolean
      microsoft: boolean
    } | null>(null)
    const [selectedProvider, setSelectedProvider] = useState<'google' | 'microsoft' | null>(provider || null)

    // Check if we just completed OAuth and restore selected provider (on mount only)
    // This handles the case where we return from OAuth redirect
    useEffect(() => {
      const storedProvider = sessionStorage.getItem(`oauth_widget_${messageId}_provider`) as
        | 'google'
        | 'microsoft'
        | null
      const oauthCompleted = sessionStorage.getItem(`oauth_widget_${messageId}_completed`) === 'true'

      if (storedProvider && oauthCompleted) {
        setConnectedProvider(storedProvider)
        setIsConnected(true)
        setSelectedProvider(storedProvider)
        // Clear the flags
        sessionStorage.removeItem(`oauth_widget_${messageId}_provider`)
        sessionStorage.removeItem(`oauth_widget_${messageId}_completed`)
      }
    }, [messageId])

    // Check which integrations are connected
    useEffect(() => {
      const checkIntegrations = async () => {
        try {
          const { integrationsGoogleCredentials, integrationsMicrosoftCredentials } = await getSettings({
            integrations_google_credentials: '',
            integrations_microsoft_credentials: '',
          })

          const googleConnected = !!integrationsGoogleCredentials && integrationsGoogleCredentials !== ''
          const microsoftConnected = !!integrationsMicrosoftCredentials && integrationsMicrosoftCredentials !== ''

          setAvailableProviders({
            google: googleConnected,
            microsoft: microsoftConnected,
          })

          // If a specific provider is required and it's already connected, mark as connected
          if (provider) {
            const isProviderConnected = provider === 'google' ? googleConnected : microsoftConnected
            if (isProviderConnected && !isConnected) {
              // Integration already connected - hide widget by marking as connected
              setIsConnected(true)
              setConnectedProvider(provider)
              setSelectedProvider(provider)
            }
          } else {
            // Check if the required service is already available via any connected provider
            const requiredProvider =
              service === 'email' || service === 'both' ? googleConnected || microsoftConnected : googleConnected // Calendar only supports Google currently

            if (requiredProvider && !isConnected) {
              // If both are connected, show as connected to the first one
              // If only one is connected, use that one
              const connectedProvider = googleConnected ? 'google' : 'microsoft'
              setIsConnected(true)
              setConnectedProvider(connectedProvider)
              setSelectedProvider(connectedProvider)
            }
          }

          // Don't auto-select - always show selection when provider is not specified
          // This lets the user choose which provider they want to connect
        } catch (err) {
          console.error('Failed to check integrations:', err)
          // Default to showing both options if check fails
          setAvailableProviders({ google: false, microsoft: false })
        }
      }

      checkIntegrations()
    }, [provider, service, isConnected])

    const { connect, processCallback, error } = useOAuthConnect({
      onSuccess: () => {
        setIsConnecting(false)
        setIsConnected(true)
        if (selectedProvider) {
          setConnectedProvider(selectedProvider)
          // Store completion state and trigger retry
          sessionStorage.setItem(`oauth_widget_${messageId}_provider`, selectedProvider)
          sessionStorage.setItem(`oauth_widget_${messageId}_completed`, 'true')
          // Trigger retry of original request
          sessionStorage.setItem('oauth_trigger_retry', 'true')
        }
      },
      onError: (err) => {
        setIsConnecting(false)
        // Ignore the expected redirect error in web flow - it's not a real error
        if (err.message === 'Redirecting for OAuth') {
          return
        }
      },
      returnContext: 'integrations',
    })

    // Handle OAuth callback when returning to chat from OAuth redirect
    useEffect(() => {
      const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
      const oauth = locationState?.oauth
      if (!oauth) return

      const handleCallback = async () => {
        try {
          await processCallback(oauth)
          // After successful OAuth, mark as completed and trigger retry
          const storedProvider = sessionStorage.getItem(`oauth_widget_${messageId}_provider`) as
            | 'google'
            | 'microsoft'
            | null
          if (storedProvider) {
            // Mark as completed so the other useEffect can pick it up
            sessionStorage.setItem(`oauth_widget_${messageId}_completed`, 'true')
            // Update local state immediately
            setConnectedProvider(storedProvider)
            setIsConnected(true)
            setSelectedProvider(storedProvider)
            // Trigger retry of original request - delay to ensure navigation completes
            setTimeout(() => {
              sessionStorage.setItem('oauth_trigger_retry', 'true')
              // Dispatch a custom event to trigger the retry check immediately
              window.dispatchEvent(new CustomEvent('oauth-retry-trigger'))
            }, 500)
          }
        } catch (err) {
          console.error('Failed to complete OAuth:', err)
        } finally {
          // Clear the OAuth state from location
          navigate(location.pathname, { replace: true, state: null })
        }
      }

      handleCallback()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.state, messageId])

    const handleConnect = async () => {
      if (!selectedProvider) return
      setIsConnecting(true)

      // Store selected provider so we can restore it after OAuth
      sessionStorage.setItem(`oauth_widget_${messageId}_provider`, selectedProvider)

      // Store current location in returnContext so we can return to it after OAuth
      // Only override if we're not already in settings/integrations
      if (!location.pathname.startsWith('/settings/integrations')) {
        sessionStorage.setItem('oauth_return_context', location.pathname)
      }

      try {
        await connect(selectedProvider as OAuthProvider)
      } catch (err) {
        console.error('Failed to connect integration:', err)
      }
    }

    const handleDismiss = () => {
      setIsDismissed(true)
    }

    if (isDismissed) {
      return (
        <Card className="border border-border rounded-lg my-4">
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground text-center">You can connect integrations later in Settings.</p>
          </CardContent>
        </Card>
      )
    }

    const serviceName = getServiceName(service)
    const displayReason = reason || getDefaultReason(service)

    // Wait for integration check to complete
    if (availableProviders === null) {
      return (
        <Card className="border border-border rounded-lg my-4 max-w-md mx-auto">
          <CardContent className="p-6">
            <div className="flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          </CardContent>
        </Card>
      )
    }

    // Show provider selection if provider not specified AND not connected
    if (!selectedProvider && !isConnected) {
      const GoogleIconComp = getIconComponent('google', service)
      const MicrosoftIconComp = getIconComponent('microsoft', service)

      return (
        <Card className="border border-border rounded-lg my-4 max-w-md mx-auto">
          <CardContent className="p-6">
            <div className="flex flex-col items-center space-y-4">
              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold">Choose your email provider to connect {serviceName}</h3>
                <p className="text-sm text-muted-foreground">{displayReason}</p>
              </div>

              <div className="w-full grid grid-cols-2 gap-3">
                <button
                  onClick={() => setSelectedProvider('google')}
                  disabled={isConnecting}
                  className="flex flex-col items-center justify-center p-4 border border-border rounded-lg hover:bg-accent hover:border-accent-foreground/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center justify-center w-12 h-12 mb-2">
                    <GoogleIconComp />
                  </div>
                  <span className="text-sm font-medium">Google</span>
                  <span className="text-xs text-muted-foreground">
                    {service === 'email' ? 'Gmail' : service === 'calendar' ? 'Calendar' : 'Gmail & Calendar'}
                  </span>
                </button>

                <button
                  onClick={() => setSelectedProvider('microsoft')}
                  disabled={isConnecting}
                  className="flex flex-col items-center justify-center p-4 border border-border rounded-lg hover:bg-accent hover:border-accent-foreground/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center justify-center w-12 h-12 mb-2">
                    <MicrosoftIconComp />
                  </div>
                  <span className="text-sm font-medium">Microsoft</span>
                  <span className="text-xs text-muted-foreground">
                    {service === 'email' ? 'Outlook' : service === 'calendar' ? 'Calendar' : 'Outlook & Calendar'}
                  </span>
                </button>
              </div>

              <Button onClick={handleDismiss} disabled={isConnecting} variant="ghost" className="w-full">
                Do not connect
              </Button>
            </div>
          </CardContent>
        </Card>
      )
    }

    // Show single provider connection UI
    // At this point, selectedProvider should not be null (we've filtered out the selection case)
    if (!selectedProvider) return null

    const providerName = getProviderName(selectedProvider)
    const IconComponent = getIconComponent(selectedProvider, service)

    // If already connected and integration is available, hide the widget (no need to show it after refresh)
    if (isConnected && connectedProvider && availableProviders) {
      const isProviderAvailable =
        connectedProvider === 'google' ? availableProviders.google : availableProviders.microsoft

      if (isProviderAvailable) {
        // Integration is connected and available - hide widget after page refresh
        return null
      }
    }

    // Show connected state (only during active session, before refresh)
    if (isConnected && connectedProvider) {
      const connectedProviderName = getProviderName(connectedProvider)
      const ConnectedIconComponent = getIconComponent(connectedProvider, service)

      return (
        <Card className="border border-border rounded-lg my-4 max-w-md mx-auto">
          <CardContent className="p-6">
            <div className="flex flex-col items-center space-y-4">
              <div className="flex items-center justify-center w-20 h-20 overflow-hidden">
                <div className="scale-[3.2] origin-center">
                  <ConnectedIconComponent />
                </div>
              </div>

              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold">
                  Connected to {connectedProviderName} {serviceName}
                </h3>
                <p className="text-sm text-muted-foreground">{displayReason}</p>
              </div>

              <div className="w-full">
                <Button variant="ghost" className="w-full" disabled>
                  <Check className="w-4 h-4 mr-2 text-green-600" />
                  Connected
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )
    }

    return (
      <Card className="border border-border rounded-lg my-4 max-w-md mx-auto">
        <CardContent className="p-6">
          <div className="flex flex-col items-center space-y-4">
            <div className="flex items-center justify-center w-20 h-20 overflow-hidden">
              <div className="scale-[3.2] origin-center">
                <IconComponent />
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">
                Thunderbolt wants to connect to {providerName} {serviceName}
              </h3>
              <p className="text-sm text-muted-foreground">{displayReason}</p>
            </div>

            {error && error !== 'Redirecting for OAuth' && (
              <div className="w-full p-3 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}

            <div className="w-full space-y-2">
              <Button onClick={handleConnect} disabled={isConnecting || !selectedProvider} className="w-full" size="lg">
                {isConnecting ? 'Connecting...' : `Connect ${providerName}`}
              </Button>
              {!provider && (
                <Button
                  onClick={() => setSelectedProvider(null)}
                  disabled={isConnecting}
                  variant="ghost"
                  className="w-full"
                >
                  Choose different provider
                </Button>
              )}
              <Button onClick={handleDismiss} disabled={isConnecting} variant="ghost" className="w-full">
                Do not connect
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  },
)
