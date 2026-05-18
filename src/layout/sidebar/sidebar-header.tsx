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
import { PowerSyncStatus } from '@/components/powersync-status'
import { useIsMobile } from '@/hooks/use-mobile'
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

  return (
    <div className="pt-4 pb-2 px-2 flex items-center justify-between flex-shrink-0">
      <div
        className="flex items-center gap-3 h-8 px-2 relative flex-1"
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
        ) : isExpanded ? (
          <>
            <img
              src="/thunderbolt-logo-light.svg"
              alt="Thunderbolt"
              width={136}
              height={15}
              draggable={false}
              className="h-[15px] w-auto select-none dark:hidden"
            />
            <img
              src="/thunderbolt-logo-dark.svg"
              alt="Thunderbolt"
              width={136}
              height={15}
              draggable={false}
              className="hidden h-[15px] w-auto select-none dark:block"
            />
          </>
        ) : (
          <AppLogo />
        )}
      </div>
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
  )
}
