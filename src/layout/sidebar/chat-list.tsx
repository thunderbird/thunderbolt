/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import { cn } from '@/lib/utils'
import { Flame, Loader2, Search } from 'lucide-react'
import { ChatActions } from './chat-actions'
import { ChatListItem } from './chat-list-item'
import { RailDivider } from './rail-divider'
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
  onRename,
  onSearchClick,
  onSearchQueryChange,
}: ChatListProps) => {
  return (
    <>
      <SidebarGroup className={cn('flex-1 flex flex-col min-h-0', isCollapsed && 'pt-0')}>
        {!isCollapsed && (chatThreads.length > 0 || debouncedSearchQuery) && (
          <div className="flex items-center justify-between flex-shrink-0">
            <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
            <ChatActions
              isCollapsed={isCollapsed}
              debouncedSearchQuery={debouncedSearchQuery}
              showSearch={showSearch}
              deleteAllChatsMutation={deleteAllChatsMutation}
              deleteAllChatsDialogRef={deleteAllChatsDialogRef}
              onSearchClick={onSearchClick}
            />
          </div>
        )}
        {/* overflow-hidden in BOTH states: while max-height animates, the input
            would otherwise escape the shrinking/growing box and paint over the
            first chat rows. Transition is scoped to the animated properties so
            sidebar-width changes (rail collapse) don't ride along. */}
        <div
          className={`overflow-hidden transition-[max-height,opacity,margin-top] duration-300 ease-in-out flex-shrink-0 ${
            showSearch && !isCollapsed && (chatThreads.length > 0 || debouncedSearchQuery)
              ? 'max-h-12 opacity-100 mt-2'
              : 'max-h-0 opacity-0'
          }`}
        >
          <SearchInput
            ref={searchInputRef}
            containerClassName="mb-1"
            className="bg-sidebar-accent dark:bg-sidebar-accent border-transparent focus-visible:border-border"
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
        </div>
        <SidebarMenu className="mt-2 group-data-[collapsible=icon]:mt-0 flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide touch-pan-y">
          {isCollapsed && (chatThreads.length > 0 || debouncedSearchQuery) && (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={(e) => onSearchClick(e)} tooltip="Search chats" className="cursor-pointer">
                  <Search className={`size-[var(--icon-size-default)] ${debouncedSearchQuery ? 'text-primary' : ''}`} />
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
                    <Loader2 className="size-[var(--icon-size-default)] animate-spin" />
                  ) : (
                    <Flame className="size-[var(--icon-size-default)]" />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
              {/* my-1.5 + the menu's gap-0.5 ≈ the 8px rhythm of the rail's other dividers. */}
              <li aria-hidden>
                <RailDivider className="my-1.5" />
              </li>
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
              onRename={onRename}
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
