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
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { getOrCreateChatThread } from '@/dal'
import { useDrizzle } from '@/db/provider'
import { chatThreadsTable } from '@/db/tables'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { desc, eq } from 'drizzle-orm'
import { Flame, Loader2, MoreHorizontal, Settings, SquarePen } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'

export default function ChatSidebar() {
  const navigate = useNavigate()
  const { db } = useDrizzle()
  const queryClient = useQueryClient()

  const { chatThreadId: currentChatThreadId } = useParams()

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
      const chatThreadId = await getOrCreateChatThread(db)
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
      const chatThreadId = await getOrCreateChatThread(db)
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate(`/chats/${chatThreadId}`)
    } catch (error) {
      console.error('Error creating new chat:', error)
    }
  }

  return (
    <Sidebar>
      <SidebarContent className="flex flex-col h-full">
        <SidebarGroup>
          <SidebarGroupContent className="flex justify-between w-full flex-1">
            <SidebarTrigger className="cursor-pointer" />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={createNewChat} className="cursor-pointer">
                  <SquarePen className="size-4" />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link to="/settings/preferences">
                    <Settings className="size-4" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
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
                    {deleteAllChatsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Flame className="size-4" />}
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
                  <Link to={`/chats/${thread.id}`}>
                    <SidebarMenuButton isActive={thread.id === currentChatThreadId} className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground cursor-pointer">
                      <span className="truncate">{thread.title}</span>
                      <DropdownMenuTrigger asChild>
                        <MoreHorizontal className="ml-auto" />
                      </DropdownMenuTrigger>
                    </SidebarMenuButton>
                  </Link>
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
