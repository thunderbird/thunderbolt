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
import { ThemeToggle } from '@/components/theme-toggle'
import { useIsMobile } from '@/hooks/use-mobile'
import { isDesktop, isTauri } from '@/lib/platform'
import { PanelLeft } from 'lucide-react'
import type { ReactNode } from 'react'

type SidebarHeaderProps = {
  onToggle: () => void
  /** Centered slot for the section nav toggle; rendered only while expanded. */
  navToggle?: ReactNode
}

export const SidebarHeader = ({ onToggle, navToggle }: SidebarHeaderProps) => {
  const { isMobile } = useIsMobile()
  const { state } = useSidebar()

  // On mobile, always treat the sidebar as expanded when it's open
  const isExpanded = isMobile || state === 'expanded'
  // Tauri desktop hides the OS title bar; the sidebar's top drag strip carries
  // the traffic lights (macOS) and, while expanded, the collapse toggle.
  const showChromeStrip = isTauri() && isDesktop() && !isMobile

  return (
    <>
      {showChromeStrip && isExpanded && (
        <div
          data-tauri-drag-region
          className="h-[var(--touch-height-xl)] bg-sidebar flex-shrink-0 relative flex items-center justify-end px-2"
        >
          {navToggle && <div className="absolute left-1/2 z-10 -translate-x-1/2">{navToggle}</div>}
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
      {showChromeStrip && !isExpanded && (
        <>
          {/* Collapsed rail: the strip stays a pure drag region and blends into
              the main header background, so no sidebar seam runs through the
              window controls (the macOS traffic lights are wider than the 48px
              rail). The sidebar surface resumes below it with a curved
              top-right shoulder, and the expand toggle is the first rail item. */}
          {/* Taller than the expanded strip (+0.5rem) so the rail's curved top
              starts with clear air below the window controls. */}
          <div
            data-tauri-drag-region
            className="h-[calc(var(--touch-height-xl)+0.5rem)] flex-shrink-0 relative bg-background"
          >
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 rounded-tr-xl bg-sidebar" />
          </div>
          <SidebarGroup className="flex-shrink-0 py-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={onToggle} className="cursor-pointer">
                    <PanelLeft className="size-[var(--icon-size-default)]" />
                    <span className="sr-only">Expand Sidebar</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </>
      )}
      {!showChromeStrip && (
        <div className="h-[var(--touch-height-xl)] relative flex items-center justify-between px-2 flex-shrink-0">
          {isExpanded && navToggle && <div className="absolute left-1/2 z-10 -translate-x-1/2">{navToggle}</div>}
          <div className="flex items-center h-8 relative flex-1 min-w-0">
            {!isExpanded && (
              <SidebarGroup className="p-0 absolute left-0 right-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={onToggle} className="cursor-pointer">
                        <PanelLeft className="size-[var(--icon-size-default)]" />
                        <span className="sr-only">Expand Sidebar</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </div>
          {isExpanded && (
            <div className="flex items-center">
              {isMobile ? (
                <>
                  <ThemeToggle />
                  <PowerSyncStatus />
                </>
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
