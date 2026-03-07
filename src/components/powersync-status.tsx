import { useAuth } from '@/contexts/auth-context'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { cn } from '@/lib/utils'
import { Cloud, CloudOff, Loader2 } from 'lucide-react'
import { SyncEnableWarningDialog } from '@/components/sync-enable-warning-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'

/**
 * PowerSync status indicator that shows sync state in the header.
 * Only renders when PowerSync is configured.
 */
export const PowerSyncStatus = () => {
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user

  const { connectionStatus, hasSynced, lastSyncedAt } = usePowerSyncStatus()
  const { syncEnabled, syncEnableWarningOpen, setSyncEnableWarningOpen, handleSyncToggle, handleConfirmEnableSync } =
    useSyncEnabledToggle()

  const isConnected = connectionStatus === 'connected'
  const isConnecting = connectionStatus === 'connecting'

  const getStatusText = () => {
    if (!syncEnabled) {
      return 'Sync disabled'
    }
    if (isConnecting) {
      return 'Connecting...'
    }
    if (!isConnected) {
      return 'Offline'
    }
    if (hasSynced && lastSyncedAt) {
      const seconds = Math.floor((Date.now() - lastSyncedAt.getTime()) / 1000)
      if (seconds < 60) {
        return 'Just synced'
      }
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) {
        return `Synced ${minutes}m ago`
      }
      const hours = Math.floor(minutes / 60)
      return `Synced ${hours}h ago`
    }
    return 'Connected'
  }

  const getIcon = () => {
    if (!syncEnabled) {
      return <CloudOff className="size-[var(--icon-size-default)] text-muted-foreground" />
    }
    if (isConnecting) {
      return <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
    }
    if (!isConnected) {
      return <CloudOff className="size-[var(--icon-size-default)] text-muted-foreground" />
    }
    return <Cloud className="size-[var(--icon-size-default)] text-green-500" />
  }

  const statusNote = !isAuthenticated
    ? 'Sign in to enable sync'
    : syncEnabled && !isConnected && connectionStatus !== 'connecting'
      ? 'Changes will sync when back online'
      : null

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center gap-2 px-[var(--spacing-x-sm)] py-[var(--spacing-y-sm)] rounded-md transition-colors min-h-[var(--min-touch-height)]',
              'hover:bg-accent cursor-pointer select-none outline-none',
            )}
            aria-label="Sync status"
            aria-haspopup="dialog"
          >
            {getIcon()}
            <span className="text-xs text-muted-foreground hidden sm:inline">{getStatusText()}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom">
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex flex-row items-center justify-between mb-2">
                <label className="text-sm font-medium" htmlFor="sync-toggle">
                  Cloud Sync
                </label>
                <Switch
                  id="sync-toggle"
                  checked={syncEnabled}
                  onCheckedChange={handleSyncToggle}
                  disabled={!isAuthenticated || isConnecting}
                  aria-label="Enable cloud sync"
                />
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                Enable cloud synchronization to keep your data synced across devices.
              </p>
              {statusNote && <p className="text-xs text-muted-foreground mt-1">{statusNote}</p>}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <SyncEnableWarningDialog
        open={syncEnableWarningOpen}
        onOpenChange={setSyncEnableWarningOpen}
        onConfirm={handleConfirmEnableSync}
      />
    </>
  )
}
