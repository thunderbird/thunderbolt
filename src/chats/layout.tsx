import { ChatNavButton } from '@/components/ui/chat-nav-button'
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger } from '@/components/ui/sidebar'
import { UserNavButton } from '@/components/ui/user-nav-button'
import { useDrizzle } from '@/db/provider'
import { chatThreadsTable } from '@/db/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelLeft, SquarePen } from 'lucide-react'
import { Link, Outlet, useNavigate, useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

export function ChatLayout() {
  const navigate = useNavigate()
  const { db } = useDrizzle()
  const queryClient = useQueryClient()

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
      <div>
        <SidebarTrigger />
      </div>
      <Sidebar>
        <SidebarContent className="flex flex-col h-full">
          <div className="flex-1">
            <SidebarGroup>
              <SidebarGroupContent className="flex justify-between w-full flex-1">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={createNewChat} className="w-fit pr-0 pl-0 aspect-square items-center justify-center" tooltip="New Chat">
                      <SquarePen className="size-5" />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={createNewChat} className="w-fit pr-0 pl-0 aspect-square items-center justify-center" tooltip="New Chat">
                      <PanelLeft className="size-5" />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
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

            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {chatThreads.map((thread) => (
                    <SidebarMenuItem key={thread.id}>
                      <ChatNavButton chatTitle={thread.title ?? 'New Chat'} threadId={thread.id} />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </div>

          <SidebarMenu className="mt-auto">
            <SidebarMenuItem>
              <UserNavButton />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <div className="flex flex-col w-full">
        <Outlet />
      </div>
    </>
  )
}

export default ChatLayout
