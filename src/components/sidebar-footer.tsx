/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  Cloud,
  CloudAlert,
  CloudOff,
  Download,
  Loader2,
  LogOut,
  MessageCirclePlus,
  RefreshCw,
  Terminal,
  UserRound,
} from 'lucide-react'
import { type ReactNode, useState, useTransition } from 'react'

import type { User } from '@shared/types/auth'

import { LogoutModal } from '@/components/logout-modal'
import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { Button } from '@/components/ui/button'
import { MobileBlurBackdrop } from '@/components/ui/mobile-blur-backdrop'
import { NavLink } from '@/components/ui/nav-link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MobileSidebarScrim } from '@/components/ui/scrim'
import { SidebarFooter as ShadcnSidebarFooter, useSidebar } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { useAuth, useSignInModal } from '@/contexts'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useHaptics } from '@/hooks/use-haptics'
import type { Formatters } from '@/i18n/format'
import { useFormatters } from '@/i18n/use-formatters'
import { usePowerSyncStatus, type PowerSyncConnectionStatus } from '@/hooks/use-powersync-status'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { reconnectSync } from '@/db/powersync/sync-state'
import { getDownloadUrl } from '@/lib/download-links'
import { isWebDesktopPlatform, isTauri } from '@/lib/platform'
import { edgeSpacing, getMobileSidebarWidth, mobileSidebarWidthCss } from '@/lib/constants'
import { cn } from '@/lib/utils'

const showAppDownloads = import.meta.env.VITE_SHOW_APP_DOWNLOADS === 'true'

const openLink = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

type SidebarFooterProps = {
  className?: string
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

/** Lucide's Cloud outline drawn with the brand gradient stroke — the healthy
 *  "sync connected" state. */
const GradientCloud = ({ className }: { className?: string }) => (
  <BrandGradientIcon className={className}>
    {/* Path data mirrors lucide-react's Cloud so the glyph stays identical. */}
    {(stroke) => <path stroke={stroke} d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />}
  </BrandGradientIcon>
)

/**
 * Single cloud glyph carrying both auth and sync state:
 * - logged out            → muted outline cloud
 * - logged in, sync off   → muted CloudOff ("connected account, not syncing")
 * - syncing, connecting   → spinner
 * - syncing, offline      → amber CloudAlert ("will sync when back online")
 * - syncing, connected    → brand gradient cloud, the healthy steady state
 *
 * Exported for tests/reuse.
 */
export const SyncStateIcon = ({
  isLoggedIn,
  syncEnabled,
  connectionStatus,
}: {
  isLoggedIn: boolean
  syncEnabled: boolean
  connectionStatus: PowerSyncConnectionStatus
}) => {
  if (!isLoggedIn) {
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
  return <GradientCloud className={cn(iconSize, 'shrink-0')} />
}

/**
 * Human status line for the account menu's Cloud Sync section. Exported for tests.
 *
 * Takes `i18n` and the formatters rather than resolving either through the
 * global: the copy has to follow the active catalog, and one branch
 * interpolates a runtime value, so the descriptors can't all live at module
 * scope.
 */
export const syncStatusText = (
  i18n: I18n,
  formatters: Formatters,
  syncEnabled: boolean,
  connectionStatus: PowerSyncConnectionStatus,
  hasSynced: boolean,
  lastSyncedAt: Date | null,
): string => {
  if (!syncEnabled) {
    return i18n._(msg`Keep your data synced across devices.`)
  }
  if (connectionStatus === 'connecting') {
    return i18n._(msg`Connecting…`)
  }
  if (connectionStatus !== 'connected') {
    return i18n._(msg`Offline. Changes will sync when back online.`)
  }
  if (hasSynced && lastSyncedAt) {
    const secondsAgo = (Date.now() - lastSyncedAt.getTime()) / 1000
    if (secondsAgo < 60) {
      return i18n._(msg`Just synced`)
    }
    const relative = formatters.relativeTime(lastSyncedAt)
    return i18n._(msg`Synced ${relative}`)
  }
  return i18n._(msg`Connected`)
}

export const SidebarFooter = ({ className }: SidebarFooterProps) => {
  const { i18n, t } = useLingui()
  const formatters = useFormatters()
  const authClient = useAuth()
  const { isMobile, setOpenMobile, state } = useSidebar()
  const { openSignInModal } = useSignInModal()
  const [logoutModalOpen, setLogoutModalOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isReconnecting, startReconnect] = useTransition()
  const { triggerImpact } = useHaptics()

  const handleMenuOpenChange = (open: boolean) => {
    triggerImpact('light')
    setMenuOpen(open)
  }

  const isDesktopCollapsed = !isMobile && state === 'collapsed'

  const showDownloadAppButton = showAppDownloads && !isTauri() && isWebDesktopPlatform()

  const { connectionStatus, hasSynced, lastSyncedAt } = usePowerSyncStatus()
  const { syncEnabled, syncSetupOpen, setSyncSetupOpen, handleSyncToggle, handleSyncSetupComplete } =
    useSyncEnabledToggle()

  const createNewChat = useCreateNewChat()

  const handleNewChat = () => {
    triggerImpact('light')
    createNewChat()
    setOpenMobile(false)
  }

  const { data: session, isPending } = authClient.useSession()
  // Treat anonymous sessions as logged-out for the footer UI: anonymous users have a
  // synthetic email and no real account, so showing them as "logged in" is misleading.
  // The Sign In affordance (below) is the correct surface for them to upgrade.
  // better-auth's inferred session-user shape carries plugin fields loosely
  // (`isAnonymous: boolean | null | undefined`) and omits app-only columns
  // like `isNew`, so it isn't assignable to the full shared `User`. The
  // footer reads exactly these fields — declare that instead of casting, so
  // a better-auth shape drift fails the type-check here.
  const sessionUser: (Pick<User, 'name' | 'email'> & { isAnonymous?: boolean | null }) | undefined = session?.user
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

  const handleRetry = () => {
    startReconnect(async () => {
      await reconnectSync()
    })
  }

  const stateIcon = <SyncStateIcon isLoggedIn={!!user} syncEnabled={syncEnabled} connectionStatus={connectionStatus} />

  // Accounts without a name/email label collapse to an icon-only perfect circle.
  const accountLabel = (displayName ?? displayEmail ?? '').trim()

  // Full-radius and sized to hug its content on the left edge of the footer.
  const pillClassName = (hasLabel: boolean) =>
    cn(
      'flex h-[var(--touch-height-lg)] max-w-full min-w-0 cursor-pointer items-center rounded-full md:h-[var(--touch-height-default)]',
      hasLabel ? 'w-fit gap-2 px-3' : 'w-[var(--touch-height-lg)] justify-center md:w-[var(--touch-height-default)]',
      'text-[length:var(--font-size-body)] transition-colors outline-none',
      'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      menuOpen && 'bg-sidebar-accent text-sidebar-accent-foreground',
    )

  const collapsedButtonClass =
    'flex size-[var(--touch-height-default)] cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-sidebar-accent'

  /**
   * The footer's one account affordance: a spinner while the session loads,
   * a sign-in button when logged out, the account-menu trigger when logged
   * in. `collapsed` renders the icon-only circle for the desktop rail; the
   * default is the labeled pill.
   */
  const renderAccountControl = (collapsed = false) => {
    const iconOnly = collapsed || isMobile
    if (isPending) {
      return iconOnly ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-full',
            isMobile ? 'size-[var(--touch-height-lg)] bg-sidebar-accent' : 'size-[var(--touch-height-default)]',
          )}
        >
          <Loader2 className={cn(iconSize, 'animate-spin text-muted-foreground')} />
        </div>
      ) : (
        <div className={cn(pillClassName(true), 'cursor-default hover:bg-transparent')}>
          <Loader2 className={cn(iconSize, 'shrink-0 animate-spin text-muted-foreground')} />
          <span className="truncate text-muted-foreground">
            <Trans>Loading…</Trans>
          </span>
        </div>
      )
    }
    const showLabel = !iconOnly && accountLabel.length > 0
    const controlClass = cn(
      collapsed ? collapsedButtonClass : pillClassName(showLabel),
      isMobile && 'bg-sidebar-accent',
    )
    if (!user) {
      return (
        <button type="button" aria-label={t`Sign in`} className={controlClass} onClick={openSignInModal}>
          {stateIcon}
        </button>
      )
    }
    return (
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t`Account menu`}
          className={cn(
            controlClass,
            collapsed && menuOpen && 'bg-sidebar-accent',
            !collapsed && isMobile && menuOpen && 'relative z-50',
          )}
        >
          {stateIcon}
          {showLabel && <span className="truncate">{accountLabel}</span>}
        </button>
      </PopoverTrigger>
    )
  }

  const isConnecting = connectionStatus === 'connecting'
  // Sync is on but not connected (and not mid-connect): show the Retry button
  // and tint the status line as a warning.
  const syncNeedsAttention = syncEnabled && !isConnecting && connectionStatus !== 'connected'

  // Three footer layouts, picked flat: desktop rail circle, mobile
  // pill + New Chat, desktop expanded pill.
  const footerControl = (() => {
    if (isDesktopCollapsed) {
      return <div className="flex flex-col items-center py-1">{renderAccountControl(true)}</div>
    }
    if (isMobile) {
      return (
        <div className="flex w-full min-w-0 items-center gap-1">
          <div className="min-w-0">{renderAccountControl()}</div>
          <Button type="button" size="lg" onClick={handleNewChat} className="ml-auto rounded-full">
            <MessageCirclePlus className={iconSize} />
            <span>
              <Trans>New Chat</Trans>
            </span>
          </Button>
        </div>
      )
    }
    return <div className="min-w-0">{renderAccountControl()}</div>
  })()

  // Popover layout (placement + width) differs wholesale between mobile
  // (centered over the sidebar) and desktop (anchored to the pill).
  const popoverLayout = isMobile
    ? {
        sideOffset: 8,
        align: 'center' as const,
        collisionPadding: edgeSpacing.mobile,
        width: `calc(${mobileSidebarWidthCss} - ${edgeSpacing.mobile * 2}px)`,
      }
    : { sideOffset: 5, align: 'start' as const, collisionPadding: 4, width: '17rem' }

  return (
    <Popover open={menuOpen} onOpenChange={handleMenuOpenChange} modal={isMobile}>
      <ShadcnSidebarFooter
        className={cn(
          'relative !gap-0 bg-transparent',
          isMobile && 'z-10 pb-[var(--mobile-sidebar-footer-inset)]',
          isDesktopCollapsed && '!p-0',
          className,
        )}
      >
        {isMobile && <MobileSidebarScrim data-slot="mobile-sidebar-footer-scrim" edge="bottom" />}
        {/* z-10 lifts the controls above the mobile footer scrim. */}
        <div className="relative z-10">{footerControl}</div>
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
        sideOffset={popoverLayout.sideOffset}
        align={popoverLayout.align}
        collisionPadding={popoverLayout.collisionPadding}
        className={cn('p-0 rounded-2xl shadow-lg overflow-hidden', isMobile && menuOpen && 'z-50')}
        style={{ width: popoverLayout.width }}
        onPointerDownOutside={(e) => {
          if (isMobile && e.detail.originalEvent.clientX > getMobileSidebarWidth(window.innerWidth)) {
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
                <Trans>Cloud Sync</Trans>
              </label>
              <Switch
                id="account-sync-toggle"
                checked={syncEnabled}
                onCheckedChange={handleSyncToggle}
                disabled={isConnecting}
                aria-label={t`Enable cloud sync`}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className={cn('text-xs text-muted-foreground', syncNeedsAttention && 'text-warning')}>
                {syncStatusText(i18n, formatters, syncEnabled, connectionStatus, hasSynced, lastSyncedAt)}
              </p>
              {syncNeedsAttention && (
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
                  <Trans>Retry</Trans>
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
                  label={t`Download App`}
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
                  label={t`Dev Settings`}
                  to="/settings/dev-settings"
                  onNavigate={handleMenuNavigate}
                />
                <AccountMenuItemButton
                  icon={<Terminal className={iconSize} />}
                  label={t`Message Simulator`}
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
              label={t`Log out`}
              onClick={() => handleMenuAction(() => setLogoutModalOpen(true))}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
