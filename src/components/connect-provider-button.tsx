import { Button } from '@/components/ui/button'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { type OAuthProvider } from '@/lib/auth'
import { Check, Loader2, X } from 'lucide-react'
import { useState } from 'react'

type ConnectProviderButtonProps = {
  provider: OAuthProvider
  isConnected?: boolean
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
}

/**
 * Reusable button for connecting OAuth providers (Google, Microsoft)
 */
export const ConnectProviderButton = ({
  provider,
  isConnected = false,
  onSuccess,
  onError,
  onDisconnect,
  setPreferredName = false,
  returnContext = 'integrations',
  className,
  variant,
  size,
  connectLabel,
  connectingLabel = 'Connecting...',
  connectedLabel = 'Connected!',
  allowDisconnect = false,
}: ConnectProviderButtonProps) => {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const { connect } = useOAuthConnect({
    onSuccess: () => {
      onSuccess?.()
    },
    onError: (error) => {
      onError?.(error)
    },
    setPreferredName,
    returnContext,
  })

  const handleClick = async () => {
    if (isConnected && allowDisconnect) {
      onDisconnect?.()
      return
    }
    if (isConnected) return

    setIsConnecting(true)
    try {
      await connect(provider)
    } finally {
      setIsConnecting(false)
    }
  }

  const providerName = provider === 'microsoft' ? 'Microsoft' : 'Google'
  const defaultConnectLabel = connectLabel || `Connect ${providerName}`

  const showDisconnect = isConnected && allowDisconnect && isHovered

  return (
    <Button
      onClick={handleClick}
      disabled={isConnecting || (isConnected && !allowDisconnect)}
      variant={isConnected ? 'ghost' : variant}
      size={size}
      className={className}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isConnected ? (
        showDisconnect ? (
          <>
            <X className="w-4 h-4 mr-2" />
            Disconnect
          </>
        ) : (
          <>
            <Check className="w-4 h-4 mr-2 text-green-600" />
            {connectedLabel}
          </>
        )
      ) : isConnecting ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          {connectingLabel}
        </>
      ) : (
        defaultConnectLabel
      )}
    </Button>
  )
}
