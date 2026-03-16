import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { SidebarFooter } from '@/components/sidebar-footer'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar'
import type { DeleteAllChatsMutationType, DeleteChatMutationType } from '@/layout/sidebar/types'
import type { MouseEvent, RefObject } from 'react'
import { useLocation } from 'react-router'
import { ChatList } from './chat-list'
import { NavigationMenu } from './navigation-menu'
import { SidebarHeader } from './sidebar-header'
import type { ChatThread } from './types'

type ChatSidebarContentProps = {
  isMobile: boolean
  isCollapsed: boolean
  chatThreads: ChatThread[]
  currentChatThreadId?: string
  searchQuery: string
  debouncedSearchQuery: string
  showSearch: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  deleteAllChatsMutation: DeleteAllChatsMutationType
  deleteChatMutation: DeleteChatMutationType
  deleteAllChatsDialogRef: RefObject<DeleteAllChatsDialogRef | null>
  deleteChatDialogRef: RefObject<DeleteChatDialogRef | null>
  threadIdRef: RefObject<string | null>
  showTasks: boolean
  onCreateNewChat: () => void
  onChatClick: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onSearchClick: (e?: MouseEvent) => void
  onSearchQueryChange: (value: string) => void
  onSettingsClick: () => void
}

export const ChatSidebarContent = ({
  isMobile,
  isCollapsed,
  chatThreads,
  currentChatThreadId,
  searchQuery,
  debouncedSearchQuery,
  showSearch,
  searchInputRef,
  deleteAllChatsMutation,
  deleteChatMutation,
  deleteAllChatsDialogRef,
  deleteChatDialogRef,
  threadIdRef,
  showTasks,
  onCreateNewChat,
  onChatClick,
  onRename,
  onSearchClick,
  onSearchQueryChange,
  onSettingsClick,
}: ChatSidebarContentProps) => {
  const { toggleSidebar } = useSidebar()
  const location = useLocation()

  return (
    <SidebarContent className="flex flex-col h-full overflow-hidden">
      <SidebarHeader onToggle={toggleSidebar} />

      <SidebarGroup className="flex-shrink-0">
        <SidebarGroupContent>
          <SidebarMenu>
            <NavigationMenu
              isMobile={isMobile}
              currentPath={location.pathname}
              showTasks={showTasks}
              onCreateNewChat={onCreateNewChat}
              onSettingsClick={onSettingsClick}
            />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarSeparator className="m-0 flex-shrink-0" />

      <ChatList
        chatThreads={chatThreads}
        currentChatThreadId={currentChatThreadId}
        isCollapsed={isCollapsed}
        isMobile={isMobile}
        debouncedSearchQuery={debouncedSearchQuery}
        deleteAllChatsMutation={deleteAllChatsMutation}
        deleteChatMutation={deleteChatMutation}
        deleteAllChatsDialogRef={deleteAllChatsDialogRef}
        deleteChatDialogRef={deleteChatDialogRef}
        threadIdRef={threadIdRef}
        searchQuery={searchQuery}
        showSearch={showSearch}
        searchInputRef={searchInputRef}
        onChatClick={onChatClick}
        onRename={onRename}
        onSearchClick={onSearchClick}
        onSearchQueryChange={onSearchQueryChange}
      />

      <SidebarFooter className="flex-shrink-0" />
    </SidebarContent>
  )
}
