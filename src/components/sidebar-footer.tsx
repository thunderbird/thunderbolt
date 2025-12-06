'use client'

import { BadgeCheck, Bell, ChevronsUpDown, CreditCard, Loader2, LogOut, Sparkles, Terminal } from 'lucide-react'
import { useState } from 'react'

import { LogoutModal } from '@/components/logout-modal'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NavLink } from '@/components/ui/nav-link'
import {
  SidebarFooter as ShadcnSidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useAuth, useSignInModal } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'

type SidebarFooterProps = {
  className?: string
}

export const SidebarFooter = ({ className }: SidebarFooterProps) => {
  const authClient = useAuth()
  const { isMobile, setOpenMobile, state } = useSidebar()
  const { openSignInModal } = useSignInModal()
  const [logoutModalOpen, setLogoutModalOpen] = useState(false)

  // On mobile, always treat the sidebar as expanded when it's open
  const isExpanded = isMobile || state === 'expanded'

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

  return (
    <ShadcnSidebarFooter className={className}>
      <SidebarMenu>
        <SidebarMenuItem>
          {isPending ? (
            // Loading state
            <SidebarMenuButton size="lg" className="cursor-default">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
              {isExpanded && (
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate text-muted-foreground">Loading...</span>
                </div>
              )}
            </SidebarMenuButton>
          ) : !user ? (
            // Not logged in - show "Sign In" button
            <SidebarMenuButton size="lg" className="cursor-pointer" onClick={handleSignInClick}>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
              </div>
              {isExpanded && (
                <div className="flex flex-1 flex-col justify-center text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Sign In</span>
                  <span className="truncate text-xs text-muted-foreground">Sync chats between devices</span>
                </div>
              )}
            </SidebarMenuButton>
          ) : (
            // Logged in - show user menu
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border">
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                  </div>
                  {isExpanded && (
                    <>
                      <div className="flex flex-1 flex-col justify-center text-left text-sm leading-tight">
                        {displayName && <span className="truncate font-semibold">{displayName}</span>}
                        <span className="truncate text-xs">{displayEmail}</span>
                      </div>
                      <ChevronsUpDown className="ml-auto size-4" />
                    </>
                  )}
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                side={isMobile ? 'bottom' : 'right'}
                align="end"
                sideOffset={4}
              >
                <DropdownMenuLabel className="p-0 font-normal">
                  <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border">
                      <Sparkles className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex flex-1 flex-col justify-center text-left text-sm leading-tight">
                      {displayName && <span className="truncate font-semibold">{displayName}</span>}
                      <span className="truncate text-xs">{displayEmail}</span>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem className="cursor-pointer">
                    <Sparkles />
                    Upgrade to Pro
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem className="cursor-pointer">
                    <BadgeCheck />
                    Account
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer">
                    <CreditCard />
                    Billing
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer">
                    <Bell />
                    Notifications
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem asChild>
                    <NavLink to="/settings/dev-settings" className="cursor-pointer">
                      <Terminal className="mr-2 size-4" />
                      Dev Settings
                    </NavLink>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <NavLink to="/message-simulator" className="cursor-pointer">
                      <Terminal className="mr-2 size-4" />
                      Message Simulator
                    </NavLink>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer" onClick={() => setLogoutModalOpen(true)}>
                  <LogOut />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </SidebarMenuItem>
      </SidebarMenu>
      <LogoutModal open={logoutModalOpen} onOpenChange={setLogoutModalOpen} />
    </ShadcnSidebarFooter>
  )
}
