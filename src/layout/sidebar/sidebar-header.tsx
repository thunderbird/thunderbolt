/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { PowerSyncStatus } from '@/components/powersync-status'
import { useIsMobile } from '@/hooks/use-mobile'
import { isDesktop, isTauri } from '@/lib/platform'
import { PanelLeft } from 'lucide-react'

type SidebarHeaderProps = {
  onToggle: () => void
}

export const SidebarHeader = ({ onToggle }: SidebarHeaderProps) => {
  const { isMobile } = useIsMobile()
  const { state } = useSidebar()

  // On mobile, always treat the sidebar as expanded when it's open
  const isExpanded = isMobile || state === 'expanded'
  // Tauri desktop hides the OS title bar; the sidebar's top drag strip carries
  // the traffic lights (macOS) and the collapse toggle. Below that strip the
  // sidebar-header row would be empty (logo/text removed to match how most
  // apps present their sidebar), so skip it entirely on this path.
  const showChromeStrip = isTauri() && isDesktop() && !isMobile

  return (
    <>
      {showChromeStrip && (
        <div
          data-tauri-drag-region
          className="h-[var(--touch-height-xl)] bg-sidebar flex-shrink-0 flex items-center justify-end px-2"
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-[var(--touch-height-sm)] cursor-pointer"
            onClick={onToggle}
          >
            <PanelLeft className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Collapse Sidebar</span>
          </Button>
        </div>
      )}
      {!showChromeStrip && (
        <div className="h-[var(--touch-height-xl)] border-b border-border flex items-center justify-end px-2 flex-shrink-0">
          {!isExpanded && (
            <div className="flex items-center gap-3 h-8 px-2 relative flex-1">
              <SidebarGroup className="p-0 absolute left-0 right-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={onToggle} tooltip="Expand Sidebar" className="cursor-pointer">
                        <PanelLeft className="size-[var(--icon-size-default)]" />
                        <span className="sr-only">Expand Sidebar</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </div>
          )}
          {isExpanded && (
            <div className="flex items-center">
              {isMobile ? (
                <PowerSyncStatus />
              ) : (
                <SidebarGroup className="p-0 w-auto">
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem className="w-auto">
                        <SidebarMenuButton
                          onClick={onToggle}
                          tooltip="Toggle Sidebar"
                          className="cursor-pointer size-8 justify-center"
                        >
                          <PanelLeft className="size-[var(--icon-size-default)]" />
                          <span className="sr-only">Toggle Sidebar</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
