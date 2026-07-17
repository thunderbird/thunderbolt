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
import { isDesktop, isMacDesktop, isTauri } from '@/lib/platform'
import { cn } from '@/lib/utils'
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
          className="h-[var(--touch-height-xl)] bg-sidebar flex-shrink-0 flex items-center gap-2 px-2"
        >
          {/* Same spot as the collapsed state's toggle in the main Header (and
              the mobile-layout burger): just right of the macOS traffic
              lights, so the button doesn't jump when the sidebar toggles. The
              nav pill right-aligns opposite it. */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-[var(--touch-height-sm)] shrink-0 cursor-pointer text-muted-foreground hover:text-foreground',
              isMacDesktop() && 'ml-20',
            )}
            onClick={onToggle}
          >
            <PanelLeft className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Collapse Sidebar</span>
          </Button>
          {navToggle && (
            <div data-tauri-drag-region className="flex flex-1 items-center justify-end">
              {navToggle}
            </div>
          )}
        </div>
      )}
      {showChromeStrip && !isExpanded && (
        <>
          {/* Collapsed rail: the strip stays a pure drag region and blends into
              the main header background, so no sidebar seam runs through the
              window controls (the macOS traffic lights are wider than the 48px
              rail). The sidebar surface resumes below it with a curved
              top-right shoulder. The expand toggle lives in the main Header
              (right of the traffic lights), not in the rail. */}
          {/* Taller than the expanded strip (+0.5rem) so the rail's curved top
              starts with clear air below the window controls. */}
          <div
            data-tauri-drag-region
            className="h-[calc(var(--touch-height-xl)+0.5rem)] flex-shrink-0 relative bg-background"
          >
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 rounded-tr-xl bg-sidebar" />
          </div>
        </>
      )}
      {!showChromeStrip && (
        <div className="h-[var(--touch-height-xl)] relative flex items-center justify-between px-2 flex-shrink-0">
          {/* Desktop web right-aligns the nav pill opposite the toggle,
              matching the desktop-app strip. The mobile overlay carries its
              pill in the footer row (thumb reach) instead of up here. */}
          {isExpanded && !isMobile && navToggle && <div className="absolute right-2 z-10">{navToggle}</div>}
          <div className="flex items-center h-8 relative flex-1 min-w-0">
            {/* Desktop web: the toggle lives in the same left slot whether the
                sidebar is expanded or collapsed, so the mouse never has to
                chase it across the header. Mobile's overlay sidebar closes by
                tapping outside, so it carries no toggle. */}
            {!isMobile && (
              <SidebarGroup className="p-0 absolute left-0 right-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={onToggle}
                        tooltip="Toggle Sidebar"
                        className="cursor-pointer size-8 justify-center text-muted-foreground hover:text-foreground"
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
          {isExpanded && isMobile && (
            <div className="flex items-center">
              <ThemeToggle />
              <PowerSyncStatus />
            </div>
          )}
        </div>
      )}
    </>
  )
}
