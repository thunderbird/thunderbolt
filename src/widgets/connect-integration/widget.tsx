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
import { useSettings } from '@/hooks/use-settings'
import { type OAuthProvider } from '@/lib/auth'
import { oauthRetryFlag, oauthRetryEvent, getOAuthWidgetKey, connectedStateDisplayDuration } from './constants'
import { Check } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

type ConnectIntegrationWidgetProps = {
  provider: 'google' | 'microsoft' | ''
  service: 'email' | 'calendar' | 'both'
  reason: string
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
    const { integrationsDoNotAskAgain } = useSettings({ integrations_do_not_ask_again: false })
    const [isConnecting, setIsConnecting] = useState(false)
    const [isDismissed, setIsDismissed] = useState(false)
    const [isConnected, setIsConnected] = useState(false)
    const [connectedProvider, setConnectedProvider] = useState<'google' | 'microsoft' | null>(null)
    const [showConnectedState, setShowConnectedState] = useState(false)
    const [availableProviders, setAvailableProviders] = useState<{
      google: boolean
      microsoft: boolean
    } | null>(null)
    const [selectedProvider, setSelectedProvider] = useState<'google' | 'microsoft' | null>(
      provider === '' ? null : provider,
    )
    const displayReason = reason === '' ? getDefaultReason(service) : reason

    useEffect(() => {
      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as
        | 'google'
        | 'microsoft'
        | null
      const oauthCompleted = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'completed')) === 'true'

      if (storedProvider && oauthCompleted) {
        const checkIntegrationStatus = async () => {
          try {
            const { integrationsGoogleCredentials, integrationsMicrosoftCredentials } = await getSettings({
              integrations_google_credentials: '',
              integrations_microsoft_credentials: '',
            })

            const googleConnected = !!integrationsGoogleCredentials && integrationsGoogleCredentials !== ''
            const microsoftConnected = !!integrationsMicrosoftCredentials && integrationsMicrosoftCredentials !== ''
            const isProviderConnected = storedProvider === 'google' ? googleConnected : microsoftConnected

            if (isProviderConnected) {
              sessionStorage.removeItem(getOAuthWidgetKey(messageId, 'provider'))
              sessionStorage.removeItem(getOAuthWidgetKey(messageId, 'completed'))
              setIsConnected(true)
              setConnectedProvider(storedProvider)
              setSelectedProvider(storedProvider)
              return
            }

            setConnectedProvider(storedProvider)
            setIsConnected(false)
            setSelectedProvider(storedProvider)
          } catch (err) {
            console.error('Failed to check integration status:', err)
            setConnectedProvider(storedProvider)
            setIsConnected(false)
            setSelectedProvider(storedProvider)
          }
        }

        checkIntegrationStatus()
      }
    }, [messageId])

    useEffect(() => {
      const checkIntegrations = async () => {
        try {
          const { integrationsGoogleCredentials, integrationsMicrosoftCredentials } = await getSettings({
            integrations_google_credentials: '',
            integrations_microsoft_credentials: '',
          })

          const googleConnected = !!integrationsGoogleCredentials && integrationsGoogleCredentials !== ''
          const microsoftConnected = !!integrationsMicrosoftCredentials && integrationsMicrosoftCredentials !== ''
          const serviceAvailable = googleConnected || microsoftConnected

          setAvailableProviders({
            google: googleConnected,
            microsoft: microsoftConnected,
          })

          if (showConnectedState) return

          const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as
            | 'google'
            | 'microsoft'
            | null
          if (storedProvider && !selectedProvider) {
            setSelectedProvider(storedProvider)
          }

          if (isConnected && connectedProvider) {
            const isProviderConnected = connectedProvider === 'google' ? googleConnected : microsoftConnected
            if (!isProviderConnected) {
              setIsConnected(false)
              setConnectedProvider(null)
            }
            return
          }

          if (provider !== '') {
            const isProviderConnected = provider === 'google' ? googleConnected : microsoftConnected
            if (isProviderConnected) {
              setIsConnected(true)
              setConnectedProvider(provider)
              setSelectedProvider(provider)
            }
            return
          }

          if (serviceAvailable) {
            const connectedProvider = googleConnected ? 'google' : 'microsoft'
            setIsConnected(true)
            setConnectedProvider(connectedProvider)
            setSelectedProvider(connectedProvider)
          }
        } catch (err) {
          console.error('Failed to check integrations:', err)
          setAvailableProviders({ google: false, microsoft: false })
        }
      }

      checkIntegrations()
    }, [provider, service, isConnected, showConnectedState, connectedProvider, messageId, selectedProvider])

    const { connect, processCallback, error } = useOAuthConnect({
      onSuccess: () => {
        setIsConnecting(false)
        setIsConnected(true)
        if (selectedProvider) {
          setConnectedProvider(selectedProvider)
          setShowConnectedState(true)
          sessionStorage.setItem(getOAuthWidgetKey(messageId, 'provider'), selectedProvider)
          sessionStorage.setItem(getOAuthWidgetKey(messageId, 'completed'), 'true')
          sessionStorage.setItem(oauthRetryFlag, 'true')

          setTimeout(() => {
            setShowConnectedState(false)
          }, connectedStateDisplayDuration)
        }
      },
      onError: (err) => {
        setIsConnecting(false)
        if (err.message === 'Redirecting for OAuth') {
          return
        }
      },
      returnContext: 'integrations',
    })

    const handleOAuthCallback = async (oauth: { code?: string; state?: string; error?: string }) => {
      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as
        | 'google'
        | 'microsoft'
        | null

      if (!storedProvider) return

      setSelectedProvider(storedProvider)

      try {
        const success = await processCallback(oauth)

        if (success) {
          sessionStorage.setItem(getOAuthWidgetKey(messageId, 'completed'), 'true')
          setConnectedProvider(storedProvider)
          setIsConnected(true)
          setShowConnectedState(true)

          setTimeout(() => {
            sessionStorage.setItem(oauthRetryFlag, 'true')
            window.dispatchEvent(new CustomEvent(oauthRetryEvent))
          }, 500)

          setTimeout(() => {
            setShowConnectedState(false)
          }, connectedStateDisplayDuration)
        } else {
          setConnectedProvider(null)
          setIsConnected(false)
        }
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
        setConnectedProvider(null)
        setIsConnected(false)
      } finally {
        navigate(location.pathname, { replace: true, state: null })
      }
    }

    useEffect(() => {
      const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
      const oauth = locationState?.oauth

      if (oauth) {
        handleOAuthCallback(oauth)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.state, messageId])

    const handleConnect = async () => {
      if (!selectedProvider) return
      setIsConnecting(true)

      sessionStorage.setItem(getOAuthWidgetKey(messageId, 'provider'), selectedProvider)

      if (!location.pathname.startsWith('/settings/integrations')) {
        sessionStorage.setItem('oauth_return_context', location.pathname)
      }

      try {
        await connect(selectedProvider as OAuthProvider)
      } catch (err) {
        console.error('Failed to connect integration:', err)
      }
    }

    const handleNotNow = () => {
      setIsDismissed(true)
    }

    const handleDoNotAskAgain = async () => {
      await integrationsDoNotAskAgain.setValue(true)
      setIsDismissed(true)
    }

    if (integrationsDoNotAskAgain.value) {
      return null
    }

    if (isDismissed) {
      return (
        <Card className="w-full border border-border rounded-lg my-4">
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground text-center">You can connect integrations later in Settings.</p>
          </CardContent>
        </Card>
      )
    }

    const serviceName = getServiceName(service)

    if (availableProviders === null) {
      if (isConnected && connectedProvider && !showConnectedState) {
        return null
      }
      return (
        <Card className="w-full border border-border rounded-lg my-4">
          <CardContent className="p-6">
            <div className="flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          </CardContent>
        </Card>
      )
    }

    if (!selectedProvider && !isConnected) {
      const GoogleIconComp = getIconComponent('google', service)
      const MicrosoftIconComp = getIconComponent('microsoft', service)

      return (
        <Card className="w-full border border-border rounded-lg my-4">
          <CardContent className="p-6 flex flex-col min-h-[400px]">
            <div className="flex flex-col items-center space-y-4 flex-1">
              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold">Choose your email provider {displayReason}</h3>
              </div>

              <div className="w-full grid grid-cols-2 gap-3">
                <button
                  onClick={() => setSelectedProvider('google')}
                  disabled={isConnecting}
                  className="flex flex-col items-center justify-center p-4 border border-border rounded-lg hover:bg-accent hover:border-accent-foreground/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  <div className="flex items-center justify-center w-20 h-20 mb-2 overflow-hidden">
                    <div className="scale-[2.5] origin-center">
                      <GoogleIconComp />
                    </div>
                  </div>
                  <span className="text-sm font-medium">Google</span>
                  <span className="text-xs text-muted-foreground">
                    {service === 'email' ? 'Gmail' : service === 'calendar' ? 'Calendar' : 'Gmail & Calendar'}
                  </span>
                </button>

                <button
                  onClick={() => setSelectedProvider('microsoft')}
                  disabled={isConnecting}
                  className="flex flex-col items-center justify-center p-4 border border-border rounded-lg hover:bg-accent hover:border-accent-foreground/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  <div className="flex items-center justify-center w-20 h-20 mb-2 overflow-hidden">
                    <div className="scale-[2.5] origin-center">
                      <MicrosoftIconComp />
                    </div>
                  </div>
                  <span className="text-sm font-medium">Microsoft</span>
                  <span className="text-xs text-muted-foreground">
                    {service === 'email' ? 'Outlook' : service === 'calendar' ? 'Calendar' : 'Outlook & Calendar'}
                  </span>
                </button>
              </div>
            </div>

            <div className="mt-auto w-full">
              <div className="w-full space-y-2">
                <Button onClick={handleNotNow} disabled={isConnecting} variant="ghost" className="w-full">
                  Not now
                </Button>
                <Button onClick={handleDoNotAskAgain} disabled={isConnecting} variant="ghost" className="w-full">
                  Do not ask again
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )
    }

    if (!selectedProvider) return null

    const providerName = getProviderName(selectedProvider)
    const IconComponent = getIconComponent(selectedProvider, service)

    const isProviderAvailable =
      availableProviders && (connectedProvider === 'google' ? availableProviders.google : availableProviders.microsoft)

    if (isConnected && connectedProvider && isProviderAvailable && !showConnectedState) {
      return null
    }

    if (isConnected && connectedProvider && showConnectedState) {
      const connectedProviderName = getProviderName(connectedProvider)
      const ConnectedIconComponent = getIconComponent(connectedProvider, service)

      return (
        <Card className="w-full border border-border rounded-lg my-4">
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
      <Card className="w-full border border-border rounded-lg my-4">
        <CardContent className="p-6 flex flex-col min-h-[400px]">
          <div className="flex flex-col items-center space-y-4 flex-1">
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
              {provider === '' && (
                <Button
                  onClick={() => setSelectedProvider(null)}
                  disabled={isConnecting}
                  variant="ghost"
                  className="w-full"
                >
                  Choose different provider
                </Button>
              )}
            </div>
          </div>

          <div className="self-end w-full">
            <div className="w-full space-y-2">
              <Button onClick={handleNotNow} disabled={isConnecting} variant="ghost" className="w-full">
                Not now
              </Button>
              <Button onClick={handleDoNotAskAgain} disabled={isConnecting} variant="ghost" className="w-full">
                Do not ask again
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  },
)
