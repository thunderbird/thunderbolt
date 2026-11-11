/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSignInModal } from '@/contexts'
import { useLingui } from '@lingui/react/macro'
import { ProviderConnectionButton } from './provider-connection-button'
import { ServerConnectionModal } from '@/components/server-connection'
import { useServerAuthentication } from '@/hooks/use-local-providers'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { useState } from 'react'

type ConnectProviderButtonProps = {
  provider: OAuthProvider
  isConnected?: boolean
  isProcessing?: boolean
  onSuccess?: () => void
  onError?: (error: Error) => void
  onDisconnect?: () => void
  setPreferredName?: boolean
  returnContext?: 'onboarding' | 'integrations'
  className?: string
  variant?: 'default' | 'ghost' | 'outline' | 'secondary' | 'destructive' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  connectLabel?: string
  connectingLabel?: string
  connectedLabel?: string
  allowDisconnect?: boolean
  // Optional dependency injection for testing
  useOAuthConnectHook?: typeof useOAuthConnect
}

/**
 * Reusable button for connecting OAuth providers (Google, Microsoft)
 */
export const ConnectProviderButton = ({
  provider,
  isConnected = false,
  isProcessing = false,
  onSuccess,
  onError,
  onDisconnect,
  setPreferredName = false,
  returnContext = 'integrations',
  className,
  // Secondary, not the gradient primary: connecting a provider is a setup
  // step, not the screen's main call to action.
  variant = 'secondary',
  size,
  connectLabel,
  connectingLabel: connectingLabelProp,
  connectedLabel: connectedLabelProp,
  allowDisconnect = false,
  useOAuthConnectHook,
}: ConnectProviderButtonProps) => {
  const { t } = useLingui()
  const [serverConnectionOpen, setServerConnectionOpen] = useState(false)
  const authenticated = useServerAuthentication()
  const connectingLabel = connectingLabelProp ?? t`Connecting…`
  const connectedLabel = connectedLabelProp ?? t`Connected!`

  // Use injected hook for testing, or real implementation in production
  const oauthHook = useOAuthConnectHook ?? useOAuthConnect
  const { connect, isConnecting: isConnectingFromHook } = oauthHook({
    onSuccess,
    onError,
    setPreferredName,
    returnContext,
  })

  const isConnecting = isConnectingFromHook || isProcessing

  const handleClick = async () => {
    if (isConnected && allowDisconnect) {
      onDisconnect?.()
      return
    }
    if (isConnected || isConnecting) {
      return
    }
    if (!authenticated) {
      setServerConnectionOpen(true)
      return
    }

    await connect(provider)
  }

  const providerName = provider === 'microsoft' ? 'Microsoft' : 'Google'
  const defaultConnectLabel = connectLabel || t`Connect ${providerName}`

  return (
    <>
      <ProviderConnectionButton
        isConnected={isConnected}
        isProcessing={isConnecting}
        onConnect={handleClick}
        onDisconnect={allowDisconnect ? onDisconnect : undefined}
        connectLabel={defaultConnectLabel}
        connectingLabel={connectingLabel}
        connectedLabel={connectedLabel}
        variant={variant}
        size={size}
        className={className}
      />
      {serverConnectionOpen && <ProviderSignInPrompt onClose={() => setServerConnectionOpen(false)} />}
    </>
  )
}

/** Mount the account sign-in bridge only when a provider connection requires it. */
const ProviderSignInPrompt = ({ onClose }: { onClose: () => void }) => {
  const { openSignInModal } = useSignInModal()
  return (
    <ServerConnectionModal
      open
      onOpenChange={onClose}
      onConnected={() => {
        onClose()
        openSignInModal()
      }}
    />
  )
}
