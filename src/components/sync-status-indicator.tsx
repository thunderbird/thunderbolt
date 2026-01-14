import type { SyncStatus } from '@/db/sync-service'
import { useSyncService } from '@/hooks/use-sync-service'
import { cn } from '@/lib/utils'
import { AlertTriangle, Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import type { FC } from 'react'
import { Button } from './ui/button'
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
 */
export const SyncStatusIndicator: FC<SyncStatusIndicatorProps> = ({ className, showLabel = false, size = 'md' }) => {
  const { status, isSupported, forceSync } = useSyncService()

  // Don't show anything if sync is not supported
  if (!isSupported) {
    return null
  }

  const config = statusConfig[status]
  const Icon = config.icon
  const iconSize = size === 'sm' ? 14 : 16
  const isVersionMismatch = status === 'version_mismatch'
  const canSync = status !== 'syncing' && status !== 'connecting' && !isVersionMismatch

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('gap-1.5 px-2', className)}
            onClick={() => canSync && forceSync()}
          >
            <Icon
              size={iconSize}
              className={cn(config.color, (status === 'syncing' || status === 'connecting') && 'animate-spin')}
              aria-hidden="true"
            />
            {showLabel && <span className={cn('text-xs', config.color)}>{config.label}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {isVersionMismatch ? (
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
  )
}
