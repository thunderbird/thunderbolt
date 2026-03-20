import { useAuth } from '@/contexts/auth-context'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { cn } from '@/lib/utils'
import { Cloud, CloudOff, Loader2 } from 'lucide-react'
import { SyncEnableWarningDialog } from '@/components/sync-enable-warning-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSignInModal } from '@/contexts/sign-in-modal-context'
import { MobileBlurBackdrop } from '@/components/ui/mobile-blur-backdrop'
import { useState } from 'react'

/**
 * PowerSync status indicator that shows sync state in the header.
 * Only renders when PowerSync is configured.
 */
export const PowerSyncStatus = () => {
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user
  const { openSignInModal } = useSignInModal()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { isMobile } = useIsMobile()

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

  const statusNote =
    syncEnabled && !isConnected && connectionStatus !== 'connecting' ? 'Changes will sync when back online' : null

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen} modal={isMobile}>
        <Tooltip open={popoverOpen ? false : undefined}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center justify-center size-[var(--touch-height-sm)] rounded-full transition-colors',
                  'hover:bg-secondary/50 cursor-pointer select-none outline-none',
                  popoverOpen && 'bg-secondary',
                  isMobile && popoverOpen && 'relative z-50',
                )}
                aria-label="Sync status"
                aria-haspopup="dialog"
              >
                {getIcon()}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{getStatusText()}</TooltipContent>
        </Tooltip>

        {isMobile && popoverOpen && <MobileBlurBackdrop onClick={() => setPopoverOpen(false)} />}

        <PopoverContent
          align={isMobile ? 'center' : 'end'}
          side="bottom"
          sideOffset={5}
          collisionPadding={isMobile ? 16 : 0}
          className={cn('rounded-2xl shadow-lg duration-100', isMobile && popoverOpen && 'z-50')}
          style={{ width: isMobile ? 'calc(100vw - 2rem)' : undefined }}
        >
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex flex-row items-center justify-between mb-2">
                <label className="text-sm font-medium" htmlFor="sync-toggle">
                  Cloud Sync
                </label>
                {isAuthenticated && (
                  <Switch
                    id="sync-toggle"
                    checked={syncEnabled}
                    onCheckedChange={handleSyncToggle}
                    disabled={isConnecting}
                    aria-label="Enable cloud sync"
                  />
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {isAuthenticated
                  ? 'Enable cloud synchronization to keep your data synced across devices.'
                  : 'Keep all of your devices synced.'}
              </p>
              {!isAuthenticated && (
                <Button
                  className="w-full mt-2"
                  onClick={() => {
                    setPopoverOpen(false)
                    openSignInModal()
                  }}
                >
                  Sign In
                </Button>
              )}
              {statusNote && isAuthenticated && <p className="text-xs text-muted-foreground mt-1">{statusNote}</p>}
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
