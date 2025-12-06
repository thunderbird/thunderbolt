import { DeleteAllChatsDialog } from '@/components/delete-all-chats-dialog'
import { DeleteChatDialog } from '@/components/delete-chat-dialog'
import { SearchInput } from '@/components/ui/search-input'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Flame, Loader2, Search } from 'lucide-react'
import { ChatActions } from './chat-actions'
import { ChatListItem } from './chat-list-item'
import type { ChatListProps } from './types'

export const ChatList = ({
  chatThreads,
  currentChatThreadId,
  isCollapsed,
  isMobile,
  debouncedSearchQuery,
  deleteAllChatsMutation,
  deleteChatMutation,
  deleteAllChatsDialogRef,
  deleteChatDialogRef,
  threadIdRef,
  searchQuery,
  showSearch,
  searchInputRef,
  onChatClick,
  onSearchClick,
  onSearchQueryChange,
}: ChatListProps) => {
  return (
    <>
      <SidebarGroup className="flex-1 flex flex-col min-h-0">
        {!isCollapsed && chatThreads.length > 0 && (
          <div className="flex items-center justify-between flex-shrink-0">
            <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
            <ChatActions
              isCollapsed={isCollapsed}
              debouncedSearchQuery={debouncedSearchQuery}
              deleteAllChatsMutation={deleteAllChatsMutation}
              deleteAllChatsDialogRef={deleteAllChatsDialogRef}
              onSearchClick={onSearchClick}
            />
          </div>
        )}
        <div
          className={`transition-all duration-300 ease-in-out flex-shrink-0 ${
            showSearch && !isCollapsed && chatThreads.length > 0
              ? 'max-h-12 opacity-100 mt-2'
              : 'max-h-0 opacity-0 overflow-hidden'
          }`}
        >
          <SearchInput
            ref={searchInputRef}
            containerClassName="mb-1"
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
        </div>
        <SidebarMenu className="mt-2 flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide touch-pan-y">
          {isCollapsed && chatThreads.length > 0 && (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={(e) => onSearchClick(e)} tooltip="Search chats" className="cursor-pointer">
                  <Search className={`size-4 ${debouncedSearchQuery ? 'text-blue-500' : ''}`} />
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => deleteAllChatsDialogRef.current?.open()}
                  disabled={deleteAllChatsMutation.isPending}
                  tooltip="Clear all chats"
                  className="cursor-pointer"
                >
                  {deleteAllChatsMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Flame className="size-4" />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}
          {chatThreads.map((thread) => (
            <ChatListItem
              key={thread.id}
              thread={thread}
              isActive={thread.id === currentChatThreadId}
              isCollapsed={isCollapsed}
              isMobile={isMobile}
              deleteChatMutation={deleteChatMutation}
              threadIdRef={threadIdRef}
              deleteChatDialogRef={deleteChatDialogRef}
              onChatClick={onChatClick}
            />
          ))}
          {chatThreads.length === 0 && debouncedSearchQuery && !isCollapsed && (
            <div className="text-center text-sm py-12 px-4 text-muted-foreground">
              No matches for "{debouncedSearchQuery}"
            </div>
          )}
        </SidebarMenu>
      </SidebarGroup>

      <DeleteAllChatsDialog onConfirm={() => deleteAllChatsMutation.mutate()} ref={deleteAllChatsDialogRef} />
      <DeleteChatDialog
        onCancel={() => {
          threadIdRef.current = null
        }}
        onConfirm={() => threadIdRef.current && deleteChatMutation.mutate({ id: threadIdRef.current })}
        ref={deleteChatDialogRef}
      />
    </>
  )
}
