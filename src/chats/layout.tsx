import { SidebarFooter } from '@/components/sidebar-footer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
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
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { useDatabase } from '@/hooks/use-database'
import { chatThreadsTable } from '@/db/tables'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { desc, eq } from 'drizzle-orm'
import { Loader2, Menu, MoreHorizontal, SquarePen } from 'lucide-react'
import { Link, Outlet, useNavigate, useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

export default function Page() {
  const navigate = useNavigate()
  const { db } = useDatabase()
  const queryClient = useQueryClient()
  const { open, setOpen } = useSidebar()
  const isMobile = useIsMobile()

  const { chatThreadId: currentChatThreadId } = useParams()

  const { data: chatThreads = [] } = useQuery({
    queryKey: ['chatThreads'],
    queryFn: async () => {
      return db.select().from(chatThreadsTable).orderBy(desc(chatThreadsTable.id))
    },
  })

  const createChatMutation = useMutation({
    mutationFn: async () => {
      const chatThreadId = uuidv7()
      // @todo libsql will throw an error that "execute returned rows" if we try to do returning()
      await db.insert(chatThreadsTable).values({ id: chatThreadId, title: 'New Chat' })
      return chatThreadId
    },
    onSuccess: (chatThreadId) => {
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate(`/chats/${chatThreadId}`)
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

  const createNewChat = () => {
    createChatMutation.mutate()
  }

  return (
    <>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <Sidebar>
          <SidebarContent className="flex flex-col h-full">
            <SidebarGroup>
              <SidebarGroupContent className="flex justify-between w-full flex-1">
                <SidebarTrigger className="cursor-pointer" />
                <SidebarMenuButton onClick={createNewChat} className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer" tooltip="New Chat">
                  <SquarePen className="size-5" />
                </SidebarMenuButton>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/">
                        <span>Home</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/settings/preferences">
                        <span>Settings</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarSeparator className="m-0" />

            <SidebarGroup>
              <SidebarGroupLabel>Dev Mode</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/devtools">
                        <span>Dev Tools</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/ui-kit">
                        <span>UI Kit</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarSeparator className="m-0" />

            <SidebarGroup className="flex-1 overflow-y-auto">
              <SidebarGroupLabel>Threads</SidebarGroupLabel>
              <SidebarMenu>
                {chatThreads.map((thread) => (
                  <DropdownMenu key={thread.id}>
                    <SidebarMenuItem>
                      <Link to={`/chats/${thread.id}`}>
                        <SidebarMenuButton isActive={thread.id === currentChatThreadId} className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground cursor-pointer">
                          {thread.title}
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
        <SidebarInset className="h-full overflow-hidden flex flex-col">
          <div className="flex h-12 w-full items-center px-4 flex-shrink-0">
            {isMobile ? (
              <SidebarTrigger className="cursor-pointer">
                <Menu className="h-5 w-5" />
              </SidebarTrigger>
            ) : (
              !open && <SidebarTrigger className="cursor-pointer" />
            )}
          </div>
          <div className="flex-1 overflow-hidden">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </>
  )
}
