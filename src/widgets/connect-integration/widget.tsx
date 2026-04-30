/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import type { ReturnContext } from '@/lib/oauth-state'
import { oauthRetryEvent, getOAuthWidgetKey, connectedStateDisplayDuration } from './constants'
import { useQueryClient } from '@tanstack/react-query'
import {
  type OAuthProviderOrEmpty,
  useConnectIntegrationWidgetState,
} from '@/hooks/use-connect-integration-widget-state'
import { ArrowLeft, Check } from 'lucide-react'
import { memo, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

type ConnectIntegrationWidgetProps = {
  provider: OAuthProviderOrEmpty
  service: 'email' | 'calendar' | 'both'
  reason: string
  messageId: string
  /** When "true", shows widget even if user chose "Don't ask again" */
  override: 'true' | ''
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
 * Checks if a provider is connected based on integration status.
 */
const isProviderConnected = (
  provider: OAuthProvider | null,
  integrationStatus: { googleConnected: boolean; microsoftConnected: boolean } | null,
): boolean => {
  if (!provider || !integrationStatus) {
    return false
  }
  return provider === 'google' ? integrationStatus.googleConnected : integrationStatus.microsoftConnected
}

/**
 * Widget that prompts users to connect their email/calendar accounts
 */
export const ConnectIntegrationWidget = memo(
  ({ provider, service, reason, messageId, override }: ConnectIntegrationWidgetProps) => {
    const location = useLocation()
    const navigate = useNavigate()
    const { integrationsDoNotAskAgain } = useSettings({ integrations_do_not_ask_again: false })
    const [state, dispatch] = useConnectIntegrationWidgetState(provider)
    const { data: integrationStatus, isLoading: isLoadingIntegrationStatus } = useIntegrationStatus()
    const queryClient = useQueryClient()
    const displayReason = reason === '' ? getDefaultReason(service) : reason

    // Use widget-specific connecting key (messageId is unique per widget instance)
    const connectingKey = `widget_${messageId}`

    const { connect, processCallback, isConnecting, error } = useOAuthConnect({
      connectingKey,
      onSuccess: async () => {
        const connectedProvider = sessionStorage.getItem(
          getOAuthWidgetKey(messageId, 'provider'),
        ) as OAuthProvider | null

        if (!connectedProvider) {
          console.warn('No provider found in sessionStorage for OAuth completion')
          return
        }

        dispatch({ type: 'CONNECT_SUCCESS', payload: connectedProvider })
        await queryClient.refetchQueries({ queryKey: ['integrationStatus'] })

        setTimeout(() => {
          dispatch({ type: 'SET_SHOW_CONNECTED_STATE', payload: false })
          window.dispatchEvent(
            new CustomEvent(oauthRetryEvent, {
              detail: { widgetMessageId: messageId },
            }),
          )
        }, connectedStateDisplayDuration)
      },
      returnContext: location.pathname as ReturnContext,
    })

    const handleOAuthCallback = async (oauth: { code?: string; state?: string; error?: string }) => {
      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as OAuthProvider | null

      if (!storedProvider) {
        return
      }

      dispatch({ type: 'SET_SELECTED_PROVIDER', payload: storedProvider })

      try {
        const success = await processCallback(oauth)
        if (!success) {
          dispatch({ type: 'CONNECT_FAILED', payload: null })
        }
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
        dispatch({ type: 'CONNECT_FAILED', payload: null })
      } finally {
        navigate(location.pathname, { replace: true, state: null })
      }
    }

    // Restore selected provider from sessionStorage on mount
    useEffect(() => {
      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(messageId, 'provider')) as OAuthProvider | null
      if (storedProvider && isConnecting) {
        dispatch({ type: 'SET_SELECTED_PROVIDER', payload: storedProvider })
      }
    }, [messageId, dispatch, isConnecting])

    useEffect(() => {
      const locationState = location.state as { oauth?: { code?: string; state?: string; error?: string } } | null
      const oauth = locationState?.oauth

      if (oauth) {
        handleOAuthCallback(oauth)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.state, messageId])

    const handleConnect = async () => {
      if (!state.selectedProvider) {
        return
      }

      sessionStorage.setItem(getOAuthWidgetKey(messageId, 'provider'), state.selectedProvider)

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

    if (integrationsDoNotAskAgain.value && override !== 'true') {
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

    if (isLoadingIntegrationStatus) {
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

    if (integrationStatus && !state.showConnectedState) {
      const providerToCheck = (state.selectedProvider || (provider !== '' ? provider : null)) as OAuthProvider | null

      if (providerToCheck && isProviderConnected(providerToCheck, integrationStatus)) {
        return null
      }

      if (
        !providerToCheck &&
        provider === '' &&
        (integrationStatus.googleConnected || integrationStatus.microsoftConnected)
      ) {
        return null
      }
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
                  onClick={() => dispatch({ type: 'SET_SELECTED_PROVIDER', payload: 'microsoft' })}
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
              <div className="w-full flex gap-2">
                <Button onClick={handleNotNow} disabled={isConnecting} variant="ghost" className="flex-1">
                  Not now
                </Button>
                <Button onClick={handleDoNotAskAgain} disabled={isConnecting} variant="ghost" className="flex-1">
                  Do not ask again
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )
    }

    if (!state.selectedProvider) {
      return null
    }

    const providerName = getProviderName(state.selectedProvider)
    const IconComponent = getIconComponent(state.selectedProvider, service)

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

    if (
      state.isConnected &&
      state.connectedProvider &&
      !state.showConnectedState &&
      isProviderConnected(state.connectedProvider, integrationStatus)
    ) {
      return null
    }

    return (
      <Card className="w-full border border-border rounded-lg my-4">
        <CardContent className="p-6 flex flex-col min-h-[400px] relative">
          {provider === '' && (
            <Button
              onClick={() => dispatch({ type: 'SET_SELECTED_PROVIDER', payload: null })}
              disabled={isConnecting}
              variant="ghost"
              size="icon"
              className="absolute top-2 left-2"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
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
            </div>

            {error && (
              <div className="w-full p-3 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}

            <div className="w-full space-y-2">
              <Button
                onClick={handleConnect}
                disabled={isConnecting || !state.selectedProvider}
                className="w-full"
                size="lg"
              >
                {isConnecting ? 'Connecting...' : `Connect ${providerName}`}
              </Button>
            </div>
          </div>

          <div className="self-end w-full">
            <div className="w-full flex gap-2">
              <Button onClick={handleNotNow} disabled={isConnecting} variant="ghost" className="flex-1">
                Not now
              </Button>
              <Button onClick={handleDoNotAskAgain} disabled={isConnecting} variant="ghost" className="flex-1">
                Do not ask again
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  },
)
