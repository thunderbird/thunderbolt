import { SidebarFooter } from '@/components/sidebar-footer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
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
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getOrCreateChatThread } from '@/dal'
import { chatThreadsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { desc, eq } from 'drizzle-orm'
import { Flame, Loader2, Lock, MessageCircle, MoreHorizontal, PanelLeftIcon, Settings, SquarePen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

export default function ChatSidebar() {
  const navigate = useNavigate()
  const { db } = useDatabase()
  const queryClient = useQueryClient()
  const { state, toggleSidebar } = useSidebar()

  const { chatThreadId: currentChatThreadId } = useParams()

  const isCollapsed = state === 'collapsed'
  const [transitionKey, setTransitionKey] = useState(0)

  // Disable tooltips completely during transitions by changing key
  useEffect(() => {
    const timer = setTimeout(() => setTransitionKey((prev) => prev + 1), 400)
    return () => clearTimeout(timer)
  }, [isCollapsed])

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

  const createNewChat = async () => {
    try {
      const chatThreadId = await getOrCreateChatThread()
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate(`/chats/${chatThreadId}`)
    } catch (error) {
      console.error('Error creating new chat:', error)
    }
  }

  return (
    <Sidebar collapsible="icon" key={`sidebar-${transitionKey}`}>
      <SidebarContent className="flex flex-col h-full">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem className="hidden md:block">
                {isCollapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton onClick={toggleSidebar} className="cursor-pointer">
                        <PanelLeftIcon className="size-4" />
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>Toggle Sidebar</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <SidebarMenuButton onClick={toggleSidebar} className="cursor-pointer">
                    <PanelLeftIcon className="size-4" />
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                {isCollapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton onClick={createNewChat} className="cursor-pointer">
                        <SquarePen className="size-4" />
                        <span>New Chat</span>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>New Chat</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <SidebarMenuButton onClick={createNewChat} className="cursor-pointer">
                    <SquarePen className="size-4" />
                    <span>New Chat</span>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
              <SidebarMenuItem>
                {isCollapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild>
                        <Link to="/settings/preferences">
                          <Settings className="size-4" />
                          <span>Settings</span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>Settings</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <SidebarMenuButton asChild>
                    <Link to="/settings/preferences">
                      <Settings className="size-4" />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="m-0" />

        <SidebarGroup className="flex-1 overflow-y-auto">
          {!isCollapsed && (
            <div className="flex items-center justify-between">
              <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuButton
                    onClick={() => deleteAllChatsMutation.mutate()}
                    className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
                    disabled={deleteAllChatsMutation.isPending}
                  >
                    {deleteAllChatsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Flame className="size-4" />}
                  </SidebarMenuButton>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>Clear all chats</p>
                </TooltipContent>
              </Tooltip>
            </div>
          )}
          {isCollapsed && <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>}
          <SidebarMenu>
            {isCollapsed && (
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton onClick={() => deleteAllChatsMutation.mutate()} className="cursor-pointer" disabled={deleteAllChatsMutation.isPending}>
                      {deleteAllChatsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Flame className="size-4" />}
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Clear all chats</p>
                  </TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            )}
            {chatThreads.map((thread) => (
              <DropdownMenu key={thread.id}>
                <SidebarMenuItem>
                  {isCollapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link to={`/chats/${thread.id}`}>
                          <SidebarMenuButton
                            isActive={thread.id === currentChatThreadId}
                            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground cursor-pointer"
                          >
                            <div className="flex items-center gap-2 flex-1">
                              <MessageCircle className="size-4 shrink-0" />
                            </div>
                          </SidebarMenuButton>
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <div className="flex items-center gap-2">
                          {Boolean(thread.isEncrypted) && <Lock className="size-3.5" />}
                          <p>{thread.title}</p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Link to={`/chats/${thread.id}`}>
                      <SidebarMenuButton isActive={thread.id === currentChatThreadId} className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground cursor-pointer">
                        <div className="flex items-center gap-2 flex-1">
                          {Boolean(thread.isEncrypted) ? <Lock className="size-3.5 shrink-0" /> : null}
                          <span className="truncate">{thread.title}</span>
                        </div>
                        <DropdownMenuTrigger asChild>
                          <MoreHorizontal className="ml-auto" />
                        </DropdownMenuTrigger>
                      </SidebarMenuButton>
                    </Link>
                  )}
                  {!isCollapsed && (
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
                  )}
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
