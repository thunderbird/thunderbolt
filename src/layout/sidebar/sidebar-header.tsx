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
    <div className="h-[var(--touch-height-xl)] border-b border-border flex items-center justify-between px-2 flex-shrink-0">
      <div
        className="flex items-center gap-2 h-8 px-2 relative flex-1"
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
            {isExpanded && <span className="text-sm truncate">Thunderbolt</span>}
          </>
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
