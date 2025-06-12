import { MobileHeader } from '@/components/mobile-header'
import { SidebarFooter } from '@/components/sidebar-footer'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ArrowLeft, Bot, PanelLeftIcon, Server, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'

export default function SettingsLayout() {
  const location = useLocation()
  const currentPath = location.pathname

  // Initialize sidebar state from localStorage
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('sidebar-state')
    return saved ? JSON.parse(saved) : true
  })

  // Save sidebar state to localStorage whenever it changes
  const handleSidebarChange = (open: boolean) => {
    setSidebarOpen(open)
    localStorage.setItem('sidebar-state', JSON.stringify(open))
  }

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={handleSidebarChange}>
      <SettingsSidebar currentPath={currentPath} />
      <SidebarInset>
        <div className="flex flex-col h-full">
          <MobileHeader />
          <div className="flex-1 overflow-auto">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function SettingsSidebar({ currentPath }: { currentPath: string }) {
  const { state, toggleSidebar } = useSidebar()
  const isCollapsed = state === 'collapsed'

  return (
    <Sidebar collapsible="icon">
      <TooltipProvider>
        <SidebarContent className="flex flex-col h-full">
          <SidebarGroup>
            <SidebarGroupContent className="flex flex-col gap-1">
              <SidebarMenu>
                <SidebarMenuItem>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton onClick={toggleSidebar} className="cursor-pointer">
                        <PanelLeftIcon className="size-4" />
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <p>Toggle Sidebar</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild className="cursor-pointer">
                        <Link to="/">
                          <ArrowLeft className="size-4" />
                          <span>Back to Chat</span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <p>Back to Chat</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator className="m-0" />

          <SidebarGroup className="flex-1 overflow-y-auto">
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild isActive={currentPath.includes('/settings/preferences')}>
                        <Link to="/settings/preferences">
                          <SlidersHorizontal className="size-4" />
                          <span>Preferences</span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <p>Preferences</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild isActive={currentPath.includes('/settings/models')}>
                        <Link to="/settings/models">
                          <Bot className="size-4" />
                          <span>Models</span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <p>Models</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild isActive={currentPath.includes('/settings/mcp-servers')}>
                        <Link to="/settings/mcp-servers">
                          <Server className="size-4" />
                          <span>MCP Servers</span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <p>MCP Servers</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarFooter />
        </SidebarContent>
      </TooltipProvider>
      <SidebarRail />
    </Sidebar>
  )
}
