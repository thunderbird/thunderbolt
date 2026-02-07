import { useAuth } from '@/contexts/auth-context'
import { isSyncEnabled, SYNC_ENABLED_CHANGE_EVENT } from '@/db/powersync'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { cn } from '@/lib/utils'
import { Cloud, CloudOff, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/**
 * PowerSync status indicator that shows sync state in the header.
 * Only renders when PowerSync is configured.
 */
export const PowerSyncStatus = () => {
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user

  const { connectionStatus, hasSynced, lastSyncedAt } = usePowerSyncStatus()
  const [syncEnabled, setSyncEnabledState] = useState(isSyncEnabled)

  // Listen for external sync enabled changes (e.g., from sign-in flow)
  useEffect(() => {
    const handleSyncEnabledChange = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>
      setSyncEnabledState(customEvent.detail)
    }

    window.addEventListener(SYNC_ENABLED_CHANGE_EVENT, handleSyncEnabledChange)
    return () => window.removeEventListener(SYNC_ENABLED_CHANGE_EVENT, handleSyncEnabledChange)
  }, [])

  const isConnected = connectionStatus === 'connected'
  const isConnecting = connectionStatus === 'connecting'

  const getStatusText = () => {
    if (!syncEnabled) return 'Sync disabled'
    if (isConnecting) return 'Connecting...'
    if (!isConnected) return 'Offline'
    if (hasSynced && lastSyncedAt) {
      const seconds = Math.floor((Date.now() - lastSyncedAt.getTime()) / 1000)
      if (seconds < 60) return 'Just synced'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `Synced ${minutes}m ago`
      const hours = Math.floor(minutes / 60)
      return `Synced ${hours}h ago`
    }
    return 'Connected'
  }

  const getIcon = () => {
    if (!syncEnabled) {
      return <CloudOff className="h-4 w-4 text-muted-foreground" />
    }
    if (isConnecting) {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    }
    if (!isConnected) {
      return <CloudOff className="h-4 w-4 text-muted-foreground" />
    }
    return <Cloud className="h-4 w-4 text-green-500" />
  }

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors',
              'hover:bg-accent cursor-default select-none',
            )}
          >
            {getIcon()}
            <span className="text-xs text-muted-foreground hidden sm:inline">{getStatusText()}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          <div className="text-sm">
            <div className="font-medium">Multi-device Sync</div>
            <div className="text-muted-foreground text-xs">
              {!isAuthenticated ? (
                'Sign in to enable sync'
              ) : syncEnabled ? (
                <>{!isConnected && connectionStatus !== 'connecting' && 'Changes will sync when back online'}</>
              ) : (
                'Enable to sync data across devices'
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
