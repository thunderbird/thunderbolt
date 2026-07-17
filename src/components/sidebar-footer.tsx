/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Cloud, CloudAlert, CloudOff, Download, Loader2, LogOut, RefreshCw, Terminal, UserRound } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import type { User } from '@shared/types/auth'

import { LogoutModal } from '@/components/logout-modal'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { MobileBlurBackdrop } from '@/components/ui/mobile-blur-backdrop'
import { NavLink } from '@/components/ui/nav-link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SidebarFooter as ShadcnSidebarFooter, useSidebar } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { useAuth, useSignInModal } from '@/contexts'
import { usePowerSyncStatus, type PowerSyncConnectionStatus } from '@/hooks/use-powersync-status'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { reconnectSync } from '@/db/powersync/sync-state'
import { getDownloadUrl } from '@/lib/download-links'
import { isWebDesktopPlatform, isTauri } from '@/lib/platform'
import { edgeSpacing, mobileSidebarWidthRatio } from '@/lib/constants'
import { cn } from '@/lib/utils'

const showAppDownloads = import.meta.env.VITE_SHOW_APP_DOWNLOADS === 'true'

const openLink = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

type SidebarFooterProps = {
  className?: string
  /** Chats/Settings pill. On the mobile overlay it renders here, at the right
   *  of the footer row, so section switching sits in thumb reach; desktop
   *  ignores it (the pill lives in the sidebar header there). */
  navToggle?: ReactNode
}

type AccountMenuItem = {
  icon: ReactNode
  label: string
  onClick?: () => void
  to?: string
  onNavigate?: () => void
}

const AccountMenuItemButton = ({ icon, label, onClick, to, onNavigate }: AccountMenuItem) => {
  const className = cn(
    'w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left cursor-pointer',
    'hover:bg-accent/50',
  )

  if (to) {
    return (
      <NavLink to={to} className={className} onClick={onNavigate}>
        {icon}
        <span>{label}</span>
      </NavLink>
    )
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

const iconSize = 'size-[var(--icon-size-default)]'

/**
 * Single cloud glyph carrying both auth and sync state:
 * - logged out            → muted outline cloud (paired with a "Sign In" label)
 * - logged in, sync off   → muted CloudOff ("connected account, not syncing")
 * - syncing, connecting   → spinner
 * - syncing, offline      → amber CloudAlert ("will sync when back online")
 * - syncing, connected    → brand-pink cloud, the healthy steady state
 */
const SyncStateIcon = ({
  loggedIn,
  syncEnabled,
  connectionStatus,
}: {
  loggedIn: boolean
  syncEnabled: boolean
  connectionStatus: PowerSyncConnectionStatus
}) => {
  if (!loggedIn) {
    return <Cloud className={cn(iconSize, 'shrink-0 text-muted-foreground')} />
  }
  if (!syncEnabled) {
    return <CloudOff className={cn(iconSize, 'shrink-0 text-muted-foreground')} />
  }
  if (connectionStatus === 'connecting') {
    return <Loader2 className={cn(iconSize, 'shrink-0 animate-spin text-muted-foreground')} />
  }
  if (connectionStatus !== 'connected') {
    return <CloudAlert className={cn(iconSize, 'shrink-0 text-warning')} />
  }
  return <Cloud className={cn(iconSize, 'shrink-0 text-brand')} />
}

/** Human status line for the account menu's Cloud Sync section. */
const syncStatusText = (
  syncEnabled: boolean,
  connectionStatus: PowerSyncConnectionStatus,
  hasSynced: boolean,
  lastSyncedAt: Date | null,
): string => {
  if (!syncEnabled) {
    return 'Keep your data synced across devices.'
  }
  if (connectionStatus === 'connecting') {
    return 'Connecting...'
  }
  if (connectionStatus !== 'connected') {
    return 'Offline — changes will sync when back online.'
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

export const SidebarFooter = ({ className, navToggle }: SidebarFooterProps) => {
  const authClient = useAuth()
  const { isMobile, setOpenMobile, state } = useSidebar()
  const { openSignInModal } = useSignInModal()
  const [logoutModalOpen, setLogoutModalOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)

  const isDesktopCollapsed = !isMobile && state === 'collapsed'

  const showDownloadAppButton = showAppDownloads && !isTauri() && isWebDesktopPlatform()

  const { connectionStatus, hasSynced, lastSyncedAt } = usePowerSyncStatus()
  const { syncEnabled, syncSetupOpen, setSyncSetupOpen, handleSyncToggle, handleSyncSetupComplete } =
    useSyncEnabledToggle()

  const handleSignInClick = () => {
    // Close mobile sidebar first so modal is visible
    setOpenMobile(false)
    openSignInModal()
  }

  const { data: session, isPending } = authClient.useSession()
  // Treat anonymous sessions as logged-out for the footer UI: anonymous users have a
  // synthetic email and no real account, so showing them as "logged in" is misleading.
  // The Sign In affordance (below) is the correct surface for them to upgrade.
  const sessionUser = session?.user as User | undefined
  const user = sessionUser?.isAnonymous ? null : sessionUser

  const displayName = user?.name ?? null
  const displayEmail = user?.email

  const handleMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  const handleMenuNavigate = () => {
    setMenuOpen(false)
  }

  const handleRetry = async () => {
    setIsReconnecting(true)
    try {
      await reconnectSync()
    } finally {
      setIsReconnecting(false)
    }
  }

  const stateIcon = <SyncStateIcon loggedIn={!!user} syncEnabled={syncEnabled} connectionStatus={connectionStatus} />

  // Accounts without a name/email label collapse to an icon-only control; it
  // must be a perfect circle matching the theme toggle beside it.
  const accountLabel = (displayName ?? displayEmail ?? '').trim()

  // Same height as the theme toggle beside it; full-radius, hugging its
  // content on the left edge of the footer.
  const pillClassName = (hasLabel: boolean) =>
    cn(
      'flex h-[var(--touch-height-sm)] max-w-full min-w-0 cursor-pointer items-center rounded-full',
      hasLabel ? 'w-fit gap-2 px-3' : 'size-[var(--touch-height-sm)] justify-center',
      'text-[length:var(--font-size-body)] transition-colors outline-none',
      'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      menuOpen && 'bg-sidebar-accent text-sidebar-accent-foreground',
    )

  const accountControl = isPending ? (
    <div className={cn(pillClassName(true), 'cursor-default hover:bg-transparent')}>
      <Loader2 className={cn(iconSize, 'shrink-0 animate-spin text-muted-foreground')} />
      <span className="truncate text-muted-foreground">Loading...</span>
    </div>
  ) : !user ? (
    <button type="button" className={pillClassName(true)} onClick={handleSignInClick}>
      {stateIcon}
      <span className="truncate">Sign In</span>
    </button>
  ) : (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label="Account menu"
        className={cn(pillClassName(accountLabel.length > 0), isMobile && menuOpen && 'relative z-50')}
      >
        {stateIcon}
        {accountLabel.length > 0 && <span className="truncate">{accountLabel}</span>}
      </button>
    </PopoverTrigger>
  )

  // Collapsed desktop rail: the theme toggle stacks above the account/sync
  // button so both stay reachable at icon-rail width.
  const collapsedControl = !user ? (
    <button
      type="button"
      aria-label="Sign in"
      className="flex size-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-sidebar-accent"
      onClick={handleSignInClick}
    >
      {stateIcon}
    </button>
  ) : (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label="Account menu"
        className={cn(
          'flex size-[var(--touch-height-sm)] cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-sidebar-accent',
          menuOpen && 'bg-sidebar-accent',
        )}
      >
        {stateIcon}
      </button>
    </PopoverTrigger>
  )

  const isConnecting = connectionStatus === 'connecting'
  const showRetry = syncEnabled && !isConnecting && connectionStatus !== 'connected'

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen} modal={isMobile}>
      <ShadcnSidebarFooter className={cn('!gap-0', isDesktopCollapsed && '!p-0', className)}>
        {isDesktopCollapsed ? (
          <div className="flex flex-col items-center gap-1 py-2">
            <ThemeToggle />
            {isPending ? (
              <div className="flex size-[var(--touch-height-sm)] items-center justify-center">
                <Loader2 className={cn(iconSize, 'animate-spin text-muted-foreground')} />
              </div>
            ) : (
              collapsedControl
            )}
          </div>
        ) : (
          <div className="flex w-full min-w-0 items-center gap-1">
            <div className="min-w-0 flex-1">{accountControl}</div>
            <div className="flex shrink-0 items-center gap-1">
              <ThemeToggle />
              {isMobile && navToggle}
            </div>
          </div>
        )}
        <LogoutModal open={logoutModalOpen} onOpenChange={setLogoutModalOpen} />
        <SyncSetupModal open={syncSetupOpen} onOpenChange={setSyncSetupOpen} onComplete={handleSyncSetupComplete} />
      </ShadcnSidebarFooter>

      {isMobile && menuOpen && (
        <MobileBlurBackdrop
          onClick={() => {
            setMenuOpen(false)
            setOpenMobile(false)
          }}
        />
      )}

      <PopoverContent
        side="top"
        sideOffset={isMobile ? 8 : 5}
        align={isMobile ? 'center' : 'start'}
        collisionPadding={isMobile ? edgeSpacing.mobile : 4}
        className={cn('p-0 rounded-2xl shadow-lg overflow-hidden', isMobile && menuOpen && 'z-50')}
        style={{
          width: isMobile ? `calc(${mobileSidebarWidthRatio * 100}vw - ${edgeSpacing.mobile * 2}px)` : '17rem',
        }}
        onPointerDownOutside={(e) => {
          if (isMobile && e.detail.originalEvent.clientX > window.innerWidth * mobileSidebarWidthRatio) {
            setOpenMobile(false)
          }
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 px-3 pt-3 pb-1 text-[length:var(--font-size-body)]">
            <div className="flex size-[var(--touch-height-sm)] shrink-0 items-center justify-center rounded-lg border border-border">
              <UserRound className={cn(iconSize, 'text-muted-foreground')} />
            </div>
            <div className="flex flex-1 flex-col justify-center text-left leading-tight min-w-0">
              {displayName && <span className="truncate font-semibold">{displayName}</span>}
              <span className="truncate text-xs text-muted-foreground">{displayEmail}</span>
            </div>
          </div>

          <div className="h-px bg-border" />

          {/* Inline Cloud Sync control — the single place a signed-in user
              enables/disables syncing now that the header indicator is gone. */}
          <div className="flex flex-col gap-1 px-3 py-1">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="account-sync-toggle"
                className="text-[length:var(--font-size-body)] font-medium cursor-pointer"
              >
                Cloud Sync
              </label>
              <Switch
                id="account-sync-toggle"
                checked={syncEnabled}
                onCheckedChange={handleSyncToggle}
                disabled={isConnecting}
                aria-label="Enable cloud sync"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p
                className={cn(
                  'text-xs text-muted-foreground',
                  syncEnabled && !isConnecting && connectionStatus !== 'connected' && 'text-warning',
                )}
              >
                {syncStatusText(syncEnabled, connectionStatus, hasSynced, lastSyncedAt)}
              </p>
              {showRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  disabled={isReconnecting}
                  onClick={handleRetry}
                >
                  {isReconnecting ? (
                    <Loader2 className="mr-1 size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 size-3" />
                  )}
                  Retry
                </Button>
              )}
            </div>
          </div>

          {showDownloadAppButton && (
            <>
              <div className="h-px bg-border" />

              <div className="flex flex-col gap-1 px-2">
                <AccountMenuItemButton
                  icon={<Download className={iconSize} />}
                  label="Download App"
                  onClick={() => openLink(getDownloadUrl())}
                />
              </div>
            </>
          )}

          {import.meta.env.DEV && (
            <>
              <div className="h-px bg-border" />

              <div className="flex flex-col gap-1 px-2">
                <AccountMenuItemButton
                  icon={<Terminal className={iconSize} />}
                  label="Dev Settings"
                  to="/settings/dev-settings"
                  onNavigate={handleMenuNavigate}
                />
                <AccountMenuItemButton
                  icon={<Terminal className={iconSize} />}
                  label="Message Simulator"
                  to="/message-simulator"
                  onNavigate={handleMenuNavigate}
                />
              </div>
            </>
          )}

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-1 px-2 pb-2">
            <AccountMenuItemButton
              icon={<LogOut className={iconSize} />}
              label="Log out"
              onClick={() => handleMenuAction(() => setLogoutModalOpen(true))}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
