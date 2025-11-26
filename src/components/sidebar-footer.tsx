'use client'

import { BadgeCheck, Bell, ChevronsUpDown, CreditCard, Loader2, LogOut, Sparkles, Terminal } from 'lucide-react'
import { useState } from 'react'

import { LogoutModal } from '@/components/logout-modal'
import { SignInModal } from '@/components/sign-in-modal'
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
import { useAuth } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'

type SidebarFooterProps = {
  className?: string
}

export const SidebarFooter = ({ className }: SidebarFooterProps) => {
  const authClient = useAuth()
  const { isMobile } = useSidebar()
  const [signInModalOpen, setSignInModalOpen] = useState(false)
  const [logoutModalOpen, setLogoutModalOpen] = useState(false)

  const { data: session, isPending } = authClient.useSession()
  const user = session?.user

  const { preferredName } = useSettings({ preferred_name: '' })

  // Loading state
  if (isPending) {
    return (
      <ShadcnSidebarFooter className={className}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="cursor-default">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate text-muted-foreground">Loading...</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </ShadcnSidebarFooter>
    )
  }

  // Not logged in - show "More Features" button
  if (!user) {
    return (
      <ShadcnSidebarFooter className={className}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="cursor-pointer" onClick={() => setSignInModalOpen(true)}>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex flex-1 flex-col justify-center text-left text-sm leading-tight">
                <span className="truncate font-semibold">Sign In</span>
                <span className="truncate text-xs text-muted-foreground">Sync chats between devices</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SignInModal open={signInModalOpen} onOpenChange={setSignInModalOpen} />
      </ShadcnSidebarFooter>
    )
  }

  // Logged in - show user menu
  // Use preferred name from settings, fallback to auth name (no fallback to 'User')
  const displayName = (preferredName.value as string) || user.name || null
  const displayEmail = user.email

  return (
    <ShadcnSidebarFooter className={className}>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border">
                  <Sparkles className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex flex-1 flex-col justify-center text-left text-sm leading-tight">
                  {displayName && <span className="truncate font-semibold">{displayName}</span>}
                  <span className="truncate text-xs">{displayEmail}</span>
                </div>
                <ChevronsUpDown className="ml-auto size-4" />
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
        </SidebarMenuItem>
      </SidebarMenu>
      <LogoutModal open={logoutModalOpen} onOpenChange={setLogoutModalOpen} />
    </ShadcnSidebarFooter>
  )
}
