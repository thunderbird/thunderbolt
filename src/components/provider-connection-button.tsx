/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Loader2, X } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'

type ProviderConnectionButtonProps = Pick<ComponentProps<typeof Button>, 'className' | 'variant' | 'size'> & {
  isConnected: boolean
  isProcessing: boolean
  connectLabel: string
  connectedLabel?: string
  connectingLabel?: string
  onConnect: () => void
  onDisconnect?: () => void
}

/** Shared connection status and hover/focus affordance for account and AI providers. */
export const ProviderConnectionButton = ({
  isConnected,
  isProcessing,
  connectLabel,
  connectedLabel,
  connectingLabel,
  onConnect,
  onDisconnect,
  className,
  variant = 'default',
  size,
}: ProviderConnectionButtonProps) => {
  const { t } = useLingui()
  const [isHighlighted, setIsHighlighted] = useState(false)
  const showDisconnect = isConnected && onDisconnect && isHighlighted
  return (
    <Button
      onClick={isConnected ? onDisconnect : onConnect}
      disabled={isProcessing || (isConnected && !onDisconnect)}
      variant={isConnected ? 'ghost' : variant}
      size={size}
      className={className}
      onMouseEnter={() => setIsHighlighted(true)}
      onMouseLeave={() => setIsHighlighted(false)}
      onFocus={() => setIsHighlighted(true)}
      onBlur={() => setIsHighlighted(false)}
      aria-label={isConnected && onDisconnect ? t`Disconnect` : undefined}
    >
      {isProcessing ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          {connectingLabel ?? t`Connecting…`}
        </>
      ) : isConnected ? (
        showDisconnect ? (
          <>
            <X className="mr-2 size-4" />
            <Trans>Disconnect</Trans>
          </>
        ) : (
          <>
            <Check className="mr-2 size-4 text-green-600" />
            {connectedLabel ?? t`Connected!`}
          </>
        )
      ) : (
        connectLabel
      )}
    </Button>
  )
}
