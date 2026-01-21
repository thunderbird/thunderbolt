import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { cn } from '@/lib/utils'
import { Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/**
 * PowerSync status indicator that shows sync state in the header.
 * Only renders when PowerSync is configured and active.
 */
export const PowerSyncStatus = () => {
  const { isPowerSync, connectionStatus, isUploading, isDownloading, hasSynced, lastSyncedAt } = usePowerSyncStatus()

  // Don't render if not using PowerSync
  if (!isPowerSync) {
    return null
  }

  const isSyncing = isUploading || isDownloading
  const isConnected = connectionStatus === 'connected'
  const isConnecting = connectionStatus === 'connecting'

  const getStatusText = () => {
    if (isConnecting) return 'Connecting...'
    if (!isConnected) return 'Offline'
    if (isSyncing) {
      if (isUploading && isDownloading) return 'Syncing...'
      if (isUploading) return 'Uploading...'
      return 'Downloading...'
    }
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
    if (isConnecting) {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    }
    if (!isConnected) {
      return <CloudOff className="h-4 w-4 text-muted-foreground" />
    }
    if (isSyncing) {
      return <RefreshCw className="h-4 w-4 animate-spin text-primary" />
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
            <div className="font-medium">PowerSync</div>
            <div className="text-muted-foreground">{getStatusText()}</div>
            {!isConnected && connectionStatus !== 'connecting' && (
              <div className="text-muted-foreground text-xs mt-1">Changes will sync when back online</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
