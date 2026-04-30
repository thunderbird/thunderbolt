/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth } from '@/contexts/auth-context'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSidebar } from '@/components/ui/sidebar'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { edgeSpacing, mobileSidebarWidthRatio } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { reconnectSync } from '@/db/powersync'
import { Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
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
  const [isReconnecting, setIsReconnecting] = useState(false)
  const { isMobile } = useIsMobile()
  const { setOpenMobile } = useSidebar()

  const { connectionStatus, hasSynced, lastSyncedAt } = usePowerSyncStatus()
  const { syncEnabled, syncSetupOpen, setSyncSetupOpen, handleSyncToggle, handleSyncSetupComplete } =
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

  const handleRetry = async () => {
    setIsReconnecting(true)
    try {
      await reconnectSync()
    } finally {
      setIsReconnecting(false)
    }
  }

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

        {isMobile && popoverOpen && (
          <MobileBlurBackdrop
            onClick={() => {
              setPopoverOpen(false)
              setOpenMobile(false)
            }}
          />
        )}

        <PopoverContent
          align={isMobile ? 'center' : 'end'}
          side="bottom"
          sideOffset={5}
          collisionPadding={
            isMobile
              ? {
                  left: edgeSpacing.mobile,
                  right: Math.round(window.innerWidth * (1 - mobileSidebarWidthRatio)) + edgeSpacing.mobile,
                }
              : 0
          }
          className={cn('rounded-2xl shadow-lg duration-100', isMobile && popoverOpen && 'z-50')}
          style={{
            width: isMobile ? `calc(${mobileSidebarWidthRatio * 100}vw - ${edgeSpacing.mobile * 2}px)` : undefined,
          }}
          onPointerDownOutside={(e) => {
            if (isMobile && e.detail.originalEvent.clientX > window.innerWidth * mobileSidebarWidthRatio) {
              setOpenMobile(false)
            }
          }}
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
              {statusNote && isAuthenticated && (
                <div className="flex items-center justify-between gap-2 mt-2">
                  <p className="text-xs text-amber-600 dark:text-amber-400">{statusNote}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-xs h-[var(--touch-height-sm)] px-2.5"
                    disabled={isReconnecting}
                    onClick={handleRetry}
                  >
                    {isReconnecting ? (
                      <Loader2 className="size-3 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="size-3 mr-1" />
                    )}
                    Retry
                  </Button>
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <SyncSetupModal open={syncSetupOpen} onOpenChange={setSyncSetupOpen} onComplete={handleSyncSetupComplete} />
    </>
  )
}
