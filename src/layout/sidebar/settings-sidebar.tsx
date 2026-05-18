/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarFooter } from '@/components/sidebar-footer'
import { Button } from '@/components/ui/button'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { ChevronLeft, Cpu, PanelLeft, Plug, Server, SlidersHorizontal, Smartphone, Store, Zap } from 'lucide-react'
import { useLocation } from 'react-router'

type SettingsSidebarContentProps = {
  onBackClick: () => void
  onSettingsNavigate: (path: string) => void
}

export const SettingsSidebarContent = ({ onBackClick, onSettingsNavigate }: SettingsSidebarContentProps) => {
  const { toggleSidebar, state } = useSidebar()
  const { isMobile } = useIsMobile()
  const location = useLocation()

  // Back-to-Chat button replaces the logo slot in the settings sidebar header.
  // When the sidebar is collapsed to icons (desktop only), show just the
  // chevron icon — matches the slot used for the logo/toggle in chat mode.
  const isExpanded = isMobile || state === 'expanded'

  return (
    <SidebarContent className="flex flex-col h-full">
      <div className="pt-4 pb-2 px-2 flex items-center justify-between flex-shrink-0 gap-1.5">
        {isExpanded ? (
          <>
            <button
              type="button"
              onClick={onBackClick}
              aria-label="Back to Chat"
              className="flex flex-1 items-center gap-2 h-[var(--touch-height-default)] rounded-lg bg-accent px-2 text-[length:var(--font-size-body)] text-accent-foreground transition-colors hover:bg-accent/80 cursor-pointer"
            >
              <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">Back to Chat</span>
            </button>
            {!isMobile && (
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={toggleSidebar}
                aria-label="Toggle sidebar"
                className="size-9 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <PanelLeft className="size-4" />
              </Button>
            )}
          </>
        ) : (
          // Collapsed (desktop icon-only): show the panel-toggle so the user can
          // expand the sidebar again. The Back-to-Chat affordance only fits in
          // the expanded layout.
          <Button
            variant="ghost"
            size="icon-lg"
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
            className="mx-auto size-9 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
      </div>

      <SidebarGroup>
        <SidebarGroupLabel>General</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/preferences')}
                tooltip="Preferences"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/preferences'}
              >
                <SlidersHorizontal className="size-4" />
                <span>Preferences</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/devices')}
                tooltip="Devices"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/devices'}
              >
                <Smartphone className="size-4" />
                <span>Devices</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="flex-1">
        <SidebarGroupLabel>Customization</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/skills')}
                tooltip="Skills"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/skills'}
              >
                <Zap className="size-4" />
                <span>Skills</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/integrations')}
                tooltip="Integrations"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/integrations'}
              >
                <Plug className="size-4" />
                <span>Integrations</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/models')}
                tooltip="Models"
                className="cursor-pointer"
                isActive={location.pathname.startsWith('/settings/models')}
              >
                <Cpu className="size-4" />
                <span>Models</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/mcp-servers')}
                tooltip="MCP Servers"
                className="cursor-pointer"
                isActive={location.pathname === '/settings/mcp-servers'}
              >
                <Server className="size-4" />
                <span>MCP Servers</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/marketplace')}
                tooltip="Marketplace"
                className="cursor-pointer"
                isActive={location.pathname.startsWith('/marketplace')}
              >
                <Store className="size-4" />
                <span>Marketplace</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarFooter />
    </SidebarContent>
  )
}
