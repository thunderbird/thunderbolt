import { SidebarFooter } from '@/components/sidebar-footer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NavLink } from '@/components/ui/nav-link'
import { SearchInput } from '@/components/ui/search-input'
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
import { DeleteAllChatsDialog, type DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { chatThreadsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { useIsMobile } from '@/hooks/use-mobile'
import { getAllChatThreads, getOrCreateChatThread } from '@/lib/dal'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import {
  ArrowLeft,
  Bot,
  CheckSquare,
  Flame,
  Loader2,
  Lock,
  MoreHorizontal,
  Plug,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { DeleteChatDialog, type DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { trackEvent } from '@/lib/analytics'
import { useBooleanSetting } from '@/hooks/use-setting'

export default function ChatSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const { setOpenMobile } = useSidebar()
  const isMobile = useIsMobile()
  const deleteAllChatsDialogRef = useRef<DeleteAllChatsDialogRef>(null)
  const deleteChatDialogRef = useRef<DeleteChatDialogRef>(null)
  const threadIdRef = useRef<string>(null)

  const { chatThreadId: currentChatThreadId } = useParams()

  // Simple route check: any /settings/* path triggers the settings sidebar variant on mobile
  const isSettingsRoute = location.pathname.startsWith('/settings')

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [isTasksEnabled] = useBooleanSetting('experimental_feature_tasks')
  const [isAutomationsEnabled] = useBooleanSetting('experimental_feature_automations')

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      // Small delay to ensure the element is visible before focusing
      setTimeout(() => {
        searchInputRef.current?.focus()
      }, 100)
    }
  }, [showSearch])

  const { data } = useQuery({
    queryKey: ['chatThreads'],
    queryFn: getAllChatThreads,
    placeholderData: (previousData) => previousData,
  })

  const chatThreads = useMemo(() => {
    if (!data) {
      return []
    }

    return data.filter((thread) => thread.title?.toLowerCase().includes(debouncedSearchQuery?.toLowerCase()))
  }, [data, debouncedSearchQuery])

  const deleteChatMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await db.delete(chatThreadsTable).where(eq(chatThreadsTable.id, id))
    },
    onSuccess: () => {
      trackEvent('chat_delete', { chat_id: threadIdRef.current })
      deleteChatDialogRef.current?.close()
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      threadIdRef.current = null
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
      trackEvent('chat_clear_all')
      deleteAllChatsDialogRef.current?.close()
      // Invalidate queries after the new thread is created
      await queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate(`/chats/${chatThreadId}`)
    },
  })

  const createNewChat = async (closeAfter: boolean = true) => {
    try {
      trackEvent('chat_new_clicked')
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

    // Track select chat event
    trackEvent('chat_select', { chat_id: threadId })

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
              {isTasksEnabled && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <NavLink to="/tasks">
                      <CheckSquare className="size-4" />
                      <span>Tasks</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {isAutomationsEnabled && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <NavLink to="/automations">
                      <Zap className="size-4" />
                      <span>Automations</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
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
            <div className="flex items-center gap-0.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      onClick={() => setShowSearch(!showSearch)}
                      className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
                    >
                      <Search className={`size-4 ${debouncedSearchQuery ? 'text-blue-500' : ''}`} />
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Search chats</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      onClick={() => deleteAllChatsDialogRef.current?.open()}
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
          </div>
          <div
            className={`transition-all duration-300 ease-in-out ${
              showSearch ? 'max-h-12 opacity-100 mt-2' : 'max-h-0 opacity-0 overflow-hidden'
            }`}
          >
            <SearchInput
              ref={searchInputRef}
              containerClassName="mb-1"
              placeholder="Search chats..."
              debouncedOnChange={setDebouncedSearchQuery}
            />
          </div>
          <SidebarMenu className="flex-1 overflow-y-auto mt-2">
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
                        threadIdRef.current = thread.id
                        deleteChatDialogRef.current?.open()
                      }}
                      disabled={deleteChatMutation.isPending}
                    >
                      {deleteChatMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Delete'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </SidebarMenuItem>
              </DropdownMenu>
            ))}
            {chatThreads.length === 0 && debouncedSearchQuery && (
              <div className="text-center text-sm py-12 px-4 text-muted-foreground">
                No matches for "{debouncedSearchQuery}"
              </div>
            )}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarFooter />
      </SidebarContent>
      <SidebarRail />
      <DeleteAllChatsDialog onConfirm={() => deleteAllChatsMutation.mutate()} ref={deleteAllChatsDialogRef} />
      <DeleteChatDialog
        onCancel={() => {
          threadIdRef.current = null
        }}
        onConfirm={() => threadIdRef.current && deleteChatMutation.mutate({ id: threadIdRef.current })}
        ref={deleteChatDialogRef}
      />
    </Sidebar>
  )
}
