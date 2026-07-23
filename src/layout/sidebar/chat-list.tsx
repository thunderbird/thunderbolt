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
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { Flame, Loader2, Search } from 'lucide-react'
import { useEffect, useRef } from 'react'
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
  hasContentAbove,
  mobileNavToggle,
  mobileSecondaryNavigation,
  onChatClick,
  onRename,
  onSearchClick,
  onSearchQueryChange,
  onContentAboveChange,
  onContentBelowChange,
}: ChatListProps) => {
  const scrollContainerRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const updateScrollShadows = () => {
      const remainingScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop
      onContentAboveChange(scrollContainer.scrollTop > 1)
      onContentBelowChange(remainingScroll > 1)
    }

    updateScrollShadows()
    scrollContainer.addEventListener('scroll', updateScrollShadows, { passive: true })
    window.addEventListener('resize', updateScrollShadows)

    return () => {
      scrollContainer.removeEventListener('scroll', updateScrollShadows)
      window.removeEventListener('resize', updateScrollShadows)
    }
  }, [chatThreads.length, debouncedSearchQuery, onContentAboveChange, onContentBelowChange, showSearch])

  const searchInput = (
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
        className="rounded-xl border-transparent bg-sidebar-accent focus-visible:border-border dark:bg-sidebar-accent"
        placeholder="Search chats..."
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
      />
    </div>
  )

  return (
    <>
      <SidebarGroup
        className={cn(
          'flex-1 flex flex-col min-h-0 pb-0',
          isCollapsed && 'pt-0',
          isMobile && isPlatformMobile() && 'pt-1',
        )}
      >
        {isMobile && (
          <div className="flex h-[var(--touch-height-lg)] flex-shrink-0 items-center justify-between">
            {mobileNavToggle}
            {(chatThreads.length > 0 || debouncedSearchQuery) && (
              <ChatActions
                isCollapsed={isCollapsed}
                debouncedSearchQuery={debouncedSearchQuery}
                showSearch={showSearch}
                deleteAllChatsMutation={deleteAllChatsMutation}
                deleteAllChatsDialogRef={deleteAllChatsDialogRef}
                onSearchClick={onSearchClick}
              />
            )}
          </div>
        )}
        {isMobile && searchInput}
        {isMobile && mobileSecondaryNavigation}
        {isMobile && !isCollapsed && (
          <SidebarGroupLabel className="mt-1">
            {chatThreads.length > 0 || debouncedSearchQuery ? 'Recent Chats' : 'No chats yet'}
          </SidebarGroupLabel>
        )}
        {!isMobile && !isCollapsed && (chatThreads.length > 0 || debouncedSearchQuery) && (
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
        {!isMobile && searchInput}
        <SidebarMenu
          ref={scrollContainerRef}
          className={cn(
            'mt-0 -mx-2 w-[calc(100%+1rem)] flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 scrollbar-hide touch-pan-y md:mt-2 group-data-[collapsible=icon]:mt-0',
            hasContentAbove && 'shadow-[inset_0_8px_16px_-14px_rgba(0,0,0,0.35)]',
          )}
        >
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
