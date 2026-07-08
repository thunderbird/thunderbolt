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
import { isMacDesktop, isTauri } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { PanelLeft } from 'lucide-react'
import { useState } from 'react'
import { AppLogo } from '@/components/app-logo'

type SidebarHeaderProps = {
  onToggle: () => void
}

export const SidebarHeader = ({ onToggle }: SidebarHeaderProps) => {
  const { isMobile } = useIsMobile()
  const { state } = useSidebar()
  const [showExpandButton, setShowExpandButton] = useState(false)

  // On mobile, always treat the sidebar as expanded when it's open
  const isExpanded = isMobile || state === 'expanded'
  // Tauri desktop hides the OS title bar; render an h-9 drag strip above the
  // sidebar row so traffic lights (macOS) or window controls (Win/Linux, in
  // the sibling strip above the main Header) have a dedicated row.
  const showChromeStrip = isTauri() && !isMobile

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
      <div className="h-[var(--touch-height-xl)] border-b border-border flex items-center justify-between px-2 flex-shrink-0">
        <div
          className={cn(
            'flex items-center gap-3 h-8 px-2 relative flex-1',
            // Only in mobile-size viewport on macOS Tauri: the sidebar renders
            // as an offcanvas drawer without a chrome strip above, so the OS
            // traffic lights (x≈16-74) sit over the logo+wordmark row. Shift
            // them past the traffic lights. On wide viewport the drag strip
            // above already carries the traffic lights so no offset is needed.
            isMacDesktop() && isMobile && 'ml-20',
          )}
          onMouseEnter={() => !isMobile && !isExpanded && setShowExpandButton(true)}
          onMouseLeave={() => !isMobile && !isExpanded && setShowExpandButton(false)}
        >
          {!isExpanded && showExpandButton ? (
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
          ) : (
            <>
              <AppLogo />
              {isExpanded && <span className="text-[length:var(--font-size-body)] truncate">Thunderbolt</span>}
            </>
          )}
        </div>
        {isExpanded && !showChromeStrip && (
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
    </>
  )
}
