import {
  BadgeCheck,
  Bell,
  ChevronsUpDown,
  CreditCard,
  Loader2,
  LogOut,
  Sparkles,
  Terminal,
  UserRound,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { LogoutModal } from '@/components/logout-modal'
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
import { cn } from '@/lib/utils'

type SidebarFooterProps = {
  className?: string
}

type AccountMenuItem = {
  icon: ReactNode
  label: string
  onClick?: () => void
  to?: string
}

const AccountMenuItemButton = ({ icon, label, onClick, to }: AccountMenuItem) => {
  const className = cn(
    'w-full flex items-center gap-2 px-3 py-2 rounded-xl transition-colors text-left cursor-pointer',
    'hover:bg-accent/50',
  )

  if (to) {
    return (
      <NavLink to={to} className={className}>
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)

  // On mobile, always treat the sidebar as expanded when it's open
  const isExpanded = isMobile || state === 'expanded'
  const isDesktopCollapsed = !isMobile && state === 'collapsed'

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

  const showBlur = isMobile && menuOpen

  // Capture trigger position when blur activates so we can render a clone above it
  useEffect(() => {
    if (showBlur && triggerRef.current) {
      setTriggerRect(triggerRef.current.getBoundingClientRect())
    } else {
      setTriggerRect(null)
    }
  }, [showBlur])

  const handleMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
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
                <button ref={triggerRef} type="button" className={triggerButtonClassName(menuOpen)}>
                  {triggerContent}
                </button>
              </PopoverTrigger>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
        <LogoutModal open={logoutModalOpen} onOpenChange={setLogoutModalOpen} />
      </ShadcnSidebarFooter>

      {/* Mobile: full-screen blur portaled above sidebar (z-50) */}
      {showBlur &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] backdrop-blur-sm bg-white/30 dark:bg-black/30"
            onClick={() => setMenuOpen(false)}
          />,
          document.body,
        )}

      {/* Mobile: clone of trigger portaled above blur so it appears unblurred */}
      {showBlur &&
        triggerRect &&
        createPortal(
          <button
            type="button"
            className={cn(triggerButtonClassName(true), 'fixed z-[65] bg-secondary')}
            style={{
              top: triggerRect.top,
              left: triggerRect.left,
              width: triggerRect.width,
              height: triggerRect.height,
            }}
            onClick={() => setMenuOpen(false)}
          >
            {triggerContent}
          </button>,
          document.body,
        )}

      <PopoverContent
        side="top"
        sideOffset={5}
        align={isMobile ? 'center' : 'start'}
        collisionPadding={isMobile ? 16 : 4}
        className={cn('p-0 rounded-2xl shadow-lg overflow-hidden', showBlur && 'z-[70]')}
        style={{
          width: isMobile
            ? 'calc(100vw - 2rem)'
            : isDesktopCollapsed
              ? '16rem'
              : 'calc(var(--radix-popover-trigger-width) - 8px)',
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

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-1 px-2">
            <AccountMenuItemButton icon={<Sparkles className={iconSize} />} label="Upgrade to Pro" />
          </div>

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-1 px-2">
            <AccountMenuItemButton icon={<BadgeCheck className={iconSize} />} label="Account" />
            <AccountMenuItemButton icon={<CreditCard className={iconSize} />} label="Billing" />
            <AccountMenuItemButton icon={<Bell className={iconSize} />} label="Notifications" />
          </div>

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-1 px-2">
            <AccountMenuItemButton
              icon={<Terminal className={iconSize} />}
              label="Dev Settings"
              to="/settings/dev-settings"
            />
            <AccountMenuItemButton
              icon={<Terminal className={iconSize} />}
              label="Message Simulator"
              to="/message-simulator"
            />
          </div>

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
