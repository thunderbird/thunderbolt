/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronsUpDown, Loader2, LogOut, Terminal, UserRound, Download } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { LogoutModal } from '@/components/logout-modal'
import { MobileBlurBackdrop } from '@/components/ui/mobile-blur-backdrop'
import { NavLink } from '@/components/ui/nav-link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  SidebarFooter as ShadcnSidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useAuth, useSignInModal } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
import { getDownloadUrl } from '@/lib/download-links'
import { isWebDesktopPlatform, isTauri } from '@/lib/platform'
import { edgeSpacing, mobileSidebarWidthRatio } from '@/lib/constants'
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

const triggerButtonClassName = (isOpen: boolean) =>
  cn(
    'flex w-full items-center gap-2 px-3 h-[var(--touch-height-xl)] cursor-pointer transition-colors text-[length:var(--font-size-body)]',
    isOpen
      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
      : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  )

export const SidebarFooter = ({ className }: SidebarFooterProps) => {
  const authClient = useAuth()
  const { isMobile, setOpenMobile, state } = useSidebar()
  const { openSignInModal } = useSignInModal()
  const [logoutModalOpen, setLogoutModalOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // On mobile, always treat the sidebar as expanded when it's open
  const isExpanded = isMobile || state === 'expanded'
  const isDesktopCollapsed = !isMobile && state === 'collapsed'

  const showDownloadAppButton = showAppDownloads && !isTauri() && isWebDesktopPlatform()

  const handleSignInClick = () => {
    // Close mobile sidebar first so modal is visible
    setOpenMobile(false)
    openSignInModal()
  }

  const { data: session, isPending } = authClient.useSession()
  const user = session?.user

  const { preferredName } = useSettings({ preferred_name: '' })
  const displayName = user ? (preferredName.value as string) || user.name || null : null
  const displayEmail = user?.email

  const handleMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  const handleMenuNavigate = () => {
    setMenuOpen(false)
  }

  const triggerContent = (
    <>
      <UserRound className="size-[var(--icon-size-default)] shrink-0 text-muted-foreground" />
      {isExpanded && (
        <>
          <div className="flex flex-1 flex-col justify-center text-left leading-tight min-w-0">
            {displayName && <span className="truncate font-semibold">{displayName}</span>}
            <span className="truncate text-xs text-muted-foreground">{displayEmail}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-[var(--icon-size-default)] shrink-0 text-muted-foreground" />
        </>
      )}
    </>
  )

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen} modal={isMobile}>
      <ShadcnSidebarFooter className={cn('border-t border-border !p-0 !gap-0', className)}>
        <SidebarMenu>
          <SidebarMenuItem>
            {isPending ? (
              // Loading state
              <SidebarMenuButton size="lg" className="cursor-default">
                <div className="flex size-[var(--touch-height-sm)] items-center justify-center rounded-lg">
                  <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
                </div>
                {isExpanded && (
                  <div className="grid flex-1 text-left text-[length:var(--font-size-body)] leading-tight">
                    <span className="truncate text-muted-foreground">Loading...</span>
                  </div>
                )}
              </SidebarMenuButton>
            ) : !user && isDesktopCollapsed ? (
              // Not logged in - collapsed desktop
              <button
                type="button"
                className={cn(
                  'flex w-full items-center justify-center h-[var(--touch-height-xl)] cursor-pointer transition-colors',
                  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
                onClick={handleSignInClick}
              >
                <UserRound className="size-[var(--icon-size-default)] text-muted-foreground" />
              </button>
            ) : !user ? (
              // Not logged in - expanded
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 px-3 h-[var(--touch-height-xl)] cursor-pointer transition-colors text-[length:var(--font-size-body)]',
                  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
                onClick={handleSignInClick}
              >
                <UserRound className="size-[var(--icon-size-default)] shrink-0 text-muted-foreground" />
                <span className="truncate">Sign In</span>
              </button>
            ) : isDesktopCollapsed ? (
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-center h-[var(--touch-height-xl)] cursor-pointer transition-colors',
                    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    menuOpen && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  )}
                >
                  <UserRound className="size-[var(--icon-size-default)] text-muted-foreground" />
                </button>
              </PopoverTrigger>
            ) : (
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(triggerButtonClassName(menuOpen), isMobile && menuOpen && 'relative z-50')}
                >
                  {triggerContent}
                </button>
              </PopoverTrigger>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
        <LogoutModal open={logoutModalOpen} onOpenChange={setLogoutModalOpen} />
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
          width: isMobile
            ? `calc(${mobileSidebarWidthRatio * 100}vw - ${edgeSpacing.mobile * 2}px)`
            : isDesktopCollapsed
              ? '16rem'
              : 'calc(var(--radix-popover-trigger-width) - 8px)',
        }}
        onPointerDownOutside={(e) => {
          if (isMobile && e.detail.originalEvent.clientX > window.innerWidth * mobileSidebarWidthRatio) {
            setOpenMobile(false)
          }
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2 bg-background">
          <div className="flex items-center gap-2 px-3 pt-3 pb-1 text-[length:var(--font-size-body)]">
            <div className="flex size-[var(--touch-height-sm)] shrink-0 items-center justify-center rounded-lg border border-border">
              <UserRound className={cn(iconSize, 'text-muted-foreground')} />
            </div>
            <div className="flex flex-1 flex-col justify-center text-left leading-tight min-w-0">
              {displayName && <span className="truncate font-semibold">{displayName}</span>}
              <span className="truncate text-xs text-muted-foreground">{displayEmail}</span>
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
