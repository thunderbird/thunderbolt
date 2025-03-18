import { SidebarFooter } from '@/components/sidebar-footer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
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
import { useDrizzle } from '@/db/provider'
import { chatThreadsTable } from '@/db/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, SquarePen } from 'lucide-react'
import { Link, Outlet, useNavigate, useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

export default function Page() {
  const navigate = useNavigate()
  const { db } = useDrizzle()
  const queryClient = useQueryClient()
  const { open, setOpen } = useSidebar()

  const { chatThreadId: currentChatThreadId } = useParams()

  const { data: chatThreads = [] } = useQuery({
    queryKey: ['chatThreads'],
    queryFn: async () => {
      return db.select().from(chatThreadsTable).orderBy(chatThreadsTable.id)
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
                <SidebarMenuButton onClick={createNewChat} className="w-fit pr-0 pl-0 aspect-square items-center justify-center" tooltip="New Chat">
                  <SquarePen className="size-5" />
                </SidebarMenuButton>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/ui-kit">
                        <span>UI Kit</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/devtools">
                        <span>Dev Tools</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarSeparator className="m-0" />

            <SidebarGroup className="flex-1 overflow-y-auto">
              <SidebarMenu>
                {chatThreads.map((thread) => (
                  <DropdownMenu key={thread.title}>
                    <SidebarMenuItem>
                      <Link to={`/chats/${thread.id}`}>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuButton className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
                            {thread.title} <MoreHorizontal className="ml-auto" />
                          </SidebarMenuButton>
                        </DropdownMenuTrigger>
                      </Link>
                      <DropdownMenuContent side="right" align="start" className="min-w-56 rounded-lg">
                        <DropdownMenuItem>Delete</DropdownMenuItem>
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
        <SidebarInset>
          <div className="flex h-12 w-full items-center px-4">{open ? null : <SidebarTrigger className="cursor-pointer" />}</div>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </>
  )
}
