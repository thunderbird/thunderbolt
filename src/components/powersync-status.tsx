import { isPowerSyncAvailable, isSyncEnabled, setSyncEnabled } from '@/db/powersync'
import { DatabaseSingleton } from '@/db/singleton'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { cn } from '@/lib/utils'
import { Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Switch } from './ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/**
 * PowerSync status indicator that shows sync state in the header.
 * Only renders when PowerSync is configured.
 * Includes a switch to enable/disable sync.
 */
export const PowerSyncStatus = () => {
  const { connectionStatus, isUploading, isDownloading, hasSynced, lastSyncedAt } = usePowerSyncStatus()
  const [syncEnabled, setSyncEnabledState] = useState(isSyncEnabled)

  // Don't render if PowerSync URL is not configured
  if (!isPowerSyncAvailable()) {
    return null
  }

  const isSyncing = isUploading || isDownloading
  const isConnected = connectionStatus === 'connected'
  const isConnecting = connectionStatus === 'connecting'

  const getStatusText = () => {
    if (!syncEnabled) return 'Sync disabled'
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
    if (!syncEnabled) {
      return <CloudOff className="h-4 w-4 text-muted-foreground" />
    }
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

  const handleToggleSync = async (enabled: boolean) => {
    setSyncEnabled(enabled)
    setSyncEnabledState(enabled)

    // Get the PowerSync database instance and connect/disconnect
    const database = DatabaseSingleton.instance.database
    if ('connectToSync' in database && 'disconnectFromSync' in database) {
      if (enabled) {
        await (database as { connectToSync: () => Promise<void> }).connectToSync()
      } else {
        await (database as { disconnectFromSync: () => Promise<void> }).disconnectFromSync()
      }
    }
  }

  return (
    <div className="flex items-center gap-2">
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
                {syncEnabled ? (
                  <>{!isConnected && connectionStatus !== 'connecting' && 'Changes will sync when back online'}</>
                ) : (
                  'Enable to sync data across devices'
                )}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Switch checked={syncEnabled} onCheckedChange={handleToggleSync} />
    </div>
  )
}
