import { useAuth } from '@/contexts/auth-context'
import { useSyncService, type SyncStatus } from '@/sync'
import { cn } from '@/lib/utils'
import { AlertTriangle, Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import type { FC } from 'react'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

const statusConfig: Record<SyncStatus, { icon: typeof Cloud; label: string; color: string }> = {
  idle: {
    icon: Cloud,
    label: 'Ready to sync',
    color: 'text-muted-foreground',
  },
  connecting: {
    icon: Loader2,
    label: 'Connecting...',
    color: 'text-blue-500',
  },
  connected: {
    icon: Cloud,
    label: 'Connected',
    color: 'text-green-500',
  },
  syncing: {
    icon: Loader2,
    label: 'Syncing...',
    color: 'text-blue-500',
  },
  error: {
    icon: CloudOff,
    label: 'Sync error',
    color: 'text-red-500',
  },
  offline: {
    icon: CloudOff,
    label: 'Offline',
    color: 'text-muted-foreground',
  },
  version_mismatch: {
    icon: AlertTriangle,
    label: 'Update required',
    color: 'text-amber-500',
  },
}

type SyncStatusIndicatorProps = {
  /** Optional additional Tailwind classes */
  className?: string
  /** Whether to show the label text */
  showLabel?: boolean
  /** Size variant */
  size?: 'sm' | 'md'
}

/**
 * Sync status indicator showing the current sync state
 * Displays an icon with optional label and allows manual sync trigger
 * Includes a switch to enable/disable sync (requires login)
 */
export const SyncStatusIndicator: FC<SyncStatusIndicatorProps> = ({ className, showLabel = false, size = 'md' }) => {
  const { status, isSupported, isEnabled, toggleEnabled, forceSync } = useSyncService()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isLoggedIn = !!session?.user

  // Don't show anything if sync is not supported
  if (!isSupported) {
    return null
  }

  const config = isEnabled ? statusConfig[status] : statusConfig.offline
  const Icon = config.icon
  const iconSize = size === 'sm' ? 14 : 16
  const isVersionMismatch = status === 'version_mismatch'
  const canSync = isEnabled && isLoggedIn && status !== 'syncing' && status !== 'connecting' && !isVersionMismatch

  const getSwitchTooltip = () => {
    if (!isLoggedIn) {
      return 'Sign in to enable sync'
    }
    return isEnabled ? 'Disable sync' : 'Enable sync'
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center">
              <Switch
                checked={isEnabled}
                onCheckedChange={toggleEnabled}
                disabled={!isLoggedIn}
                aria-label="Toggle sync"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span>{getSwitchTooltip()}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 px-2"
              onClick={() => canSync && forceSync()}
              disabled={!isEnabled || !isLoggedIn}
            >
              <Icon
                size={iconSize}
                className={cn(
                  config.color,
                  isEnabled && isLoggedIn && (status === 'syncing' || status === 'connecting') && 'animate-spin',
                )}
                aria-hidden="true"
              />
              {showLabel && (
                <span className={cn('text-xs', config.color)}>{isEnabled ? config.label : 'Sync disabled'}</span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {!isLoggedIn ? (
              <span>Sign in to enable sync</span>
            ) : !isEnabled ? (
              <span>Sync is disabled</span>
            ) : isVersionMismatch ? (
              <div className="flex flex-col gap-1">
                <span className="font-medium">Sync paused - app update required</span>
                <span className="text-muted-foreground text-xs">
                  Another device has synced with a newer version. Please update the app to continue syncing.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span>{config.label}</span>
                {canSync && (
                  <span className="text-muted-foreground text-xs flex items-center gap-1">
                    <RefreshCw size={12} />
                    Click to sync
                  </span>
                )}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
