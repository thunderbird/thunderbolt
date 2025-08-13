import { SidebarFooter } from '@/components/sidebar-footer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NavLink } from '@/components/ui/nav-link'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { chatThreadsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { useIsMobile } from '@/hooks/use-mobile'
import { getOrCreateChatThread } from '@/lib/dal'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { desc, eq } from 'drizzle-orm'
import {
    AlarmClock,
  ArrowLeft,
  Bot,
  CheckSquare,
  Flame,
  Loader2,
  Lock,
  MoreHorizontal,
  Plug,
  Server,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Zap,
} from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { useIsTauri } from '@/hooks/use-is-tauri';

export default function ChatSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { db } = useDatabase()
  const queryClient = useQueryClient()
  const { setOpenMobile } = useSidebar()
  const isMobile = useIsMobile()
  const isTauri = useIsTauri();

  const { chatThreadId: currentChatThreadId } = useParams()

  // Simple route check: any /settings/* path triggers the settings sidebar variant on mobile
  const isSettingsRoute = location.pathname.startsWith('/settings')

  const { data: chatThreads = [] } = useQuery({
    queryKey: ['chatThreads'],
    queryFn: async () => {
      return db.select().from(chatThreadsTable).orderBy(desc(chatThreadsTable.id))
    },
  })

  const deleteChatMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await db.delete(chatThreadsTable).where(eq(chatThreadsTable.id, id))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
    },
  })

  const deleteAllChatsMutation = useMutation({
    mutationFn: async () => {
      await db.delete(chatThreadsTable)
      // Create a new thread immediately after deletion
      const chatThreadId = await getOrCreateChatThread()
      return chatThreadId
    },
    onSuccess: async (chatThreadId) => {
      // Invalidate queries after the new thread is created
      await queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate(`/chats/${chatThreadId}`)
    },
  })

  const createNewChat = async (closeAfter: boolean = true) => {
    try {
      const chatThreadId = await getOrCreateChatThread()
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate(`/chats/${chatThreadId}`)
      // Close mobile sidebar after navigation
      if (closeAfter && isMobile) {
        setOpenMobile(false)
      }
    } catch (error) {
      console.error('Error creating new chat:', error)
    }
  }

  const handleChatClick = (threadId: string) => {
    navigate(`/chats/${threadId}`)
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const handleSettingsNavigation = (path: string) => {
    navigate(path)
    if (isMobile) {
      // Close the sidebar after selecting a settings link
      setOpenMobile(false)
    }
  }

  const showSettingsMenu = () => {
    if (!isSettingsRoute) {
      navigate('/settings/preferences')
    }
  }

  const goToMainMenu = async () => {
    // Navigate to the main chat page
    const chatThreadId = currentChatThreadId || (chatThreads.length > 0 ? chatThreads[0].id : null)
    if (chatThreadId) {
      navigate(`/chats/${chatThreadId}`)
    } else {
      // If no chats, create a new one
      await createNewChat(false)
    }
  }

  // SETTINGS MENU (shown on any screen when viewing settings routes)
  if (isSettingsRoute) {
    return (
      <Sidebar>
        <SidebarContent className="flex flex-col h-full">
          <SidebarGroup>
            <SidebarGroupContent className="flex justify-between w-full flex-1">
              <SidebarTrigger className="cursor-pointer hidden md:flex" />
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={goToMainMenu} className="cursor-pointer">
                    <ArrowLeft className="size-4" />
                    <span>Back</span>
                  </SidebarMenuButton>
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
                  <SidebarMenuButton
                    onClick={() => handleSettingsNavigation('/settings/preferences')}
                    className="cursor-pointer"
                  >
                    <SlidersHorizontal className="size-4" />
                    <span>Preferences</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => handleSettingsNavigation('/settings/models')}
                    className="cursor-pointer"
                  >
                    <Bot className="size-4" />
                    <span>Models</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => handleSettingsNavigation('/settings/integrations')}
                    className="cursor-pointer"
                  >
                    <Plug className="size-4" />
                    <span>Integrations</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => handleSettingsNavigation('/settings/mcp-servers')}
                    className="cursor-pointer"
                  >
                    <Server className="size-4" />
                    <span>MCP Servers</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {isTauri && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => handleSettingsNavigation('/settings/schedules')}
                      className="cursor-pointer"
                    >
                      <AlarmClock className="size-4" />
                      <span>Scheduled Tasks</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarFooter />
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    )
  }

  // MAIN MENU
  return (
    <Sidebar>
      <SidebarContent className="flex flex-col h-full">
        <SidebarGroup>
          <SidebarGroupContent className="flex justify-between w-full flex-1">
            <SidebarTrigger className="cursor-pointer hidden md:flex" />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => createNewChat()} className="cursor-pointer">
                  <SquarePen className="size-4" />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="m-0" />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <NavLink to="/tasks">
                    <CheckSquare className="size-4" />
                    <span>Tasks</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <NavLink to="/automations">
                    <Zap className="size-4" />
                    <span>Automations</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                {isMobile ? (
                  <SidebarMenuButton onClick={showSettingsMenu} className="cursor-pointer">
                    <Settings className="size-4" />
                    <span>Settings</span>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton asChild>
                    <NavLink to="/settings/preferences">
                      <Settings className="size-4" />
                      <span>Settings</span>
                    </NavLink>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="m-0" />

        <SidebarGroup className="flex-1 overflow-y-auto">
          <div className="flex items-center justify-between">
            <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuButton
                    onClick={() => deleteAllChatsMutation.mutate()}
                    className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
                    disabled={deleteAllChatsMutation.isPending}
                  >
                    {deleteAllChatsMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Flame className="size-4" />
                    )}
                  </SidebarMenuButton>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>Clear all chats</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <SidebarMenu>
            {chatThreads.map((thread) => (
              <DropdownMenu key={thread.id}>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => handleChatClick(thread.id)}
                    isActive={thread.id === currentChatThreadId}
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground cursor-pointer flex items-center gap-2"
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {thread.isEncrypted ? <Lock className="size-3.5 shrink-0" /> : null}
                      <span className="truncate">{thread.title}</span>
                    </div>
                    <DropdownMenuTrigger asChild>
                      <MoreHorizontal className="shrink-0 size-4" />
                    </DropdownMenuTrigger>
                  </SidebarMenuButton>
                  <DropdownMenuContent side="right" align="start" className="min-w-56 rounded-lg">
                    <DropdownMenuItem
                      onClick={() => {
                        deleteChatMutation.mutate({ id: thread.id })
                      }}
                      disabled={deleteChatMutation.isPending}
                    >
                      {deleteChatMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Delete'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </SidebarMenuItem>
              </DropdownMenu>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarFooter />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
