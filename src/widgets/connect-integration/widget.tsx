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
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { useSettings } from '@/hooks/use-settings'
import { useIntegrationStatus } from '@/hooks/use-integration-status'
import { type OAuthProvider } from '@/lib/auth'
import { oauthRetryEvent, getOAuthWidgetKey, connectedStateDisplayDuration } from './constants'
import {
  type OAuthProviderOrEmpty,
  useConnectIntegrationWidgetState,
} from '@/hooks/use-connect-integration-widget-state'
import { Check } from 'lucide-react'
import { memo, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

type ConnectIntegrationWidgetProps = {
  provider: OAuthProviderOrEmpty
  service: 'email' | 'calendar' | 'both'
  reason: string
  messageId: string
}

const getProviderName = (provider: OAuthProvider): string => {
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

const getIconComponent = (provider: OAuthProvider, service: 'email' | 'calendar' | 'both') => {
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
    const [state, dispatch] = useConnectIntegrationWidgetState(provider)
    const { data: integrationStatus, isLoading: isLoadingIntegrationStatus } = useIntegrationStatus()
    const displayReason = reason === '' ? getDefaultReason(service) : reason

    useEffect(() => {
      if (!integrationStatus) return

      dispatch({
        type: 'SET_AVAILABLE_PROVIDERS',
        payload: integrationStatus.availableProviders,
      })
    }, [integrationStatus, dispatch])

    useEffect(() => {
      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as OAuthProvider | null
      const oauthCompleted = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'completed')) === 'true'

      if (storedProvider && oauthCompleted && integrationStatus) {
        const isProviderConnected =
          storedProvider === 'google' ? integrationStatus.googleConnected : integrationStatus.microsoftConnected

        if (isProviderConnected) {
          sessionStorage.removeItem(getOAuthWidgetKey(messageId, 'provider'))
          sessionStorage.removeItem(getOAuthWidgetKey(messageId, 'completed'))
          sessionStorage.removeItem(getOAuthWidgetKey(messageId, 'eventDispatched'))
          dispatch({ type: 'SET_CONNECTED', payload: true })
          dispatch({ type: 'SET_CONNECTED_PROVIDER', payload: storedProvider })
          dispatch({ type: 'SET_SELECTED_PROVIDER', payload: storedProvider })
          dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: true })

          setTimeout(() => {
            dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
          }, connectedStateDisplayDuration)
        } else {
          dispatch({ type: 'SET_CONNECTED_PROVIDER', payload: storedProvider })
          dispatch({ type: 'SET_CONNECTED', payload: false })
          dispatch({ type: 'SET_SELECTED_PROVIDER', payload: storedProvider })
        }
      }
    }, [messageId, integrationStatus, dispatch])

    useEffect(() => {
      if (!integrationStatus || state.showConnectedState) return

      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as OAuthProvider | null
      if (storedProvider && !state.selectedProvider) {
        dispatch({ type: 'SET_SELECTED_PROVIDER', payload: storedProvider })
      }
    }, [messageId, integrationStatus, state.showConnectedState, state.selectedProvider, dispatch])

    useEffect(() => {
      if (!integrationStatus || !state.isConnected || !state.connectedProvider) return

      const isProviderConnected =
        state.connectedProvider === 'google' ? integrationStatus.googleConnected : integrationStatus.microsoftConnected

      if (!isProviderConnected) {
        dispatch({ type: 'SET_CONNECTED', payload: false })
        dispatch({ type: 'SET_CONNECTED_PROVIDER', payload: null })
      }
    }, [integrationStatus, state.isConnected, state.connectedProvider, dispatch])

    useEffect(() => {
      if (!integrationStatus || state.isConnected || state.showConnectedState) return

      if (provider !== '') {
        const isProviderConnected =
          provider === 'google' ? integrationStatus.googleConnected : integrationStatus.microsoftConnected
        if (isProviderConnected) {
          dispatch({ type: 'SET_CONNECTED', payload: true })
          dispatch({ type: 'SET_CONNECTED_PROVIDER', payload: provider as OAuthProvider })
          if (!state.selectedProvider) {
            dispatch({ type: 'SET_SELECTED_PROVIDER', payload: provider as OAuthProvider })
          }
        }
        return
      }

      if (!state.selectedProvider) {
        const serviceAvailable = integrationStatus.googleConnected || integrationStatus.microsoftConnected
        if (serviceAvailable) {
          const connectedProvider: OAuthProvider = integrationStatus.googleConnected ? 'google' : 'microsoft'
          dispatch({ type: 'SET_CONNECTED', payload: true })
          dispatch({ type: 'SET_CONNECTED_PROVIDER', payload: connectedProvider })
          dispatch({ type: 'SET_SELECTED_PROVIDER', payload: connectedProvider })
        }
      }
    }, [integrationStatus, provider, state.isConnected, state.showConnectedState, state.selectedProvider, dispatch])

    const { connect, processCallback, error } = useOAuthConnect({
      onSuccess: () => {
        if (state.selectedProvider) {
          dispatch({ type: 'CONNECT_SUCCESS', payload: state.selectedProvider })
          sessionStorage.setItem(getOAuthWidgetKey(messageId, 'provider'), state.selectedProvider)
          sessionStorage.setItem(getOAuthWidgetKey(messageId, 'completed'), 'true')

          const eventDispatched = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'eventDispatched'))
          if (!eventDispatched) {
            sessionStorage.setItem(getOAuthWidgetKey(messageId, 'eventDispatched'), 'true')
            setTimeout(() => {
              dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
              window.dispatchEvent(
                new CustomEvent(oauthRetryEvent, {
                  detail: { widgetMessageId: messageId },
                }),
              )
            }, connectedStateDisplayDuration)
          } else {
            setTimeout(() => {
              dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
            }, connectedStateDisplayDuration)
          }
        }
      },
      onError: (err) => {
        dispatch({ type: 'SET_CONNECTING', payload: false })
        if (err.message === 'Redirecting for OAuth') {
          return
        }
      },
      returnContext: 'integrations',
    })

    useEffect(() => {
      const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
      const oauth = locationState?.oauth

      if (!oauth) return

      const handleOAuthCallback = async (oauth: { code?: string; state?: string; error?: string }) => {
        const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as OAuthProvider | null

        if (!storedProvider) return

        dispatch({ type: 'SET_SELECTED_PROVIDER', payload: storedProvider })

        try {
          const success = await processCallback(oauth)

          if (success) {
            sessionStorage.setItem(getOAuthWidgetKey(messageId, 'completed'), 'true')
            dispatch({ type: 'CONNECT_SUCCESS', payload: storedProvider })

            const eventDispatched = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'eventDispatched'))
            if (!eventDispatched) {
              sessionStorage.setItem(getOAuthWidgetKey(messageId, 'eventDispatched'), 'true')
              setTimeout(() => {
                dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
                window.dispatchEvent(
                  new CustomEvent(oauthRetryEvent, {
                    detail: { widgetMessageId: messageId },
                  }),
                )
              }, connectedStateDisplayDuration)
            } else {
              setTimeout(() => {
                dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
              }, connectedStateDisplayDuration)
            }
          } else {
            dispatch({ type: 'CONNECT_FAILED', payload: null })
          }
        } catch (err) {
          console.error('Failed to complete OAuth:', err)
          dispatch({ type: 'CONNECT_FAILED', payload: null })
        } finally {
          navigate(location.pathname, { replace: true, state: null })
        }
      }

      handleOAuthCallback(oauth)
    }, [location, messageId, dispatch, processCallback, navigate])

    const handleConnect = async () => {
      if (!state.selectedProvider) return
      dispatch({ type: 'SET_CONNECTING', payload: true })

      sessionStorage.setItem(getOAuthWidgetKey(messageId, 'provider'), state.selectedProvider)

      if (!location.pathname.startsWith('/settings/integrations')) {
        sessionStorage.setItem('oauth_return_context', location.pathname)
      }

      try {
        await connect(state.selectedProvider as OAuthProvider)
      } catch (err) {
        console.error('Failed to connect integration:', err)
      }
    }

    const handleNotNow = () => {
      dispatch({ type: 'SET_DISMISSED', payload: true })
    }

    const handleDoNotAskAgain = async () => {
      await integrationsDoNotAskAgain.setValue(true)
      dispatch({ type: 'SET_DISMISSED', payload: true })
    }

    if (integrationsDoNotAskAgain.value) {
      return null
    }

    if (state.isDismissed) {
      return (
        <Card className="w-full border border-border rounded-lg my-4">
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground text-center">You can connect integrations later in Settings.</p>
          </CardContent>
        </Card>
      )
    }

    const serviceName = getServiceName(service)

    if (isLoadingIntegrationStatus || state.availableProviders === null) {
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

    if (!state.selectedProvider && !state.isConnected) {
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
                  onClick={() => dispatch({ type: 'SET_SELECTED_PROVIDER', payload: 'google' })}
                  disabled={state.isConnecting}
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
                  onClick={() => dispatch({ type: 'SET_SELECTED_PROVIDER', payload: 'microsoft' })}
                  disabled={state.isConnecting}
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
                <Button onClick={handleNotNow} disabled={state.isConnecting} variant="ghost" className="w-full">
                  Not now
                </Button>
                <Button onClick={handleDoNotAskAgain} disabled={state.isConnecting} variant="ghost" className="w-full">
                  Do not ask again
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )
    }

    if (!state.selectedProvider) return null

    const providerName = getProviderName(state.selectedProvider)
    const IconComponent = getIconComponent(state.selectedProvider, service)

    const isProviderAvailable =
      state.availableProviders &&
      (state.connectedProvider === 'google' ? state.availableProviders.google : state.availableProviders.microsoft)

    if (state.isConnected && state.connectedProvider && isProviderAvailable && !state.showConnectedState) {
      return null
    }

    if (state.isConnected && state.connectedProvider && state.showConnectedState) {
      const connectedProviderName = getProviderName(state.connectedProvider)
      const ConnectedIconComponent = getIconComponent(state.connectedProvider, service)

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
              <Button
                onClick={handleConnect}
                disabled={state.isConnecting || !state.selectedProvider}
                className="w-full"
                size="lg"
              >
                {state.isConnecting ? 'Connecting...' : `Connect ${providerName}`}
              </Button>
              {provider === '' && (
                <Button
                  onClick={() => dispatch({ type: 'SET_SELECTED_PROVIDER', payload: null })}
                  disabled={state.isConnecting}
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
              <Button onClick={handleNotNow} disabled={state.isConnecting} variant="ghost" className="w-full">
                Not now
              </Button>
              <Button onClick={handleDoNotAskAgain} disabled={state.isConnecting} variant="ghost" className="w-full">
                Do not ask again
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  },
)
