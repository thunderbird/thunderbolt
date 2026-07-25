/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DeleteAllChatsDialog } from '@/components/delete-all-chats-dialog'
import { DeleteChatDialog } from '@/components/delete-chat-dialog'
import { Scrim } from '@/components/ui/scrim'
import { SearchInput } from '@/components/ui/search-input'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Flame, Loader2, Search } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type Ref } from 'react'
import { Virtualizer, type CustomContainerComponentProps, type CustomItemComponentProps } from 'virtua'
import { ChatActions } from './chat-actions'
import { ChatListItem } from './chat-list-item'
import { RailDivider } from './rail-divider'
import type { ChatListProps } from './types'

/** Virtua's list container, rendered as the semantic `ul` the rows live in. */
const VirtualChatMenu = ({ style, children, ref }: CustomContainerComponentProps) => (
  <SidebarMenu ref={ref as Ref<HTMLUListElement>} style={style}>
    {children}
  </SidebarMenu>
)

/** Virtua's row wrapper: the inner padding restores the chat list's original
 * 4px rhythm. It must sit inside the observed `li`: ResizeObserver's
 * `contentRect` excludes padding on the observed element, which would make
 * virtua position the next row before that spacing. */
const VirtualChatRow = ({ style, children, ref }: CustomItemComponentProps) => (
  <li ref={ref as Ref<HTMLLIElement>} style={style}>
    <div className="pb-1">{children}</div>
  </li>
)

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
  mobileNavToggle,
  mobileSecondaryNavigation,
  onChatClick,
  onRename,
  onSearchClick,
  onSearchQueryChange,
}: ChatListProps) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const mobileHeaderRef = useRef<HTMLDivElement>(null)
  const mobileLabelRef = useRef<HTMLDivElement>(null)
  const { forceCollapsed } = useSidebar()
  const [mobileListMetrics, setMobileListMetrics] = useState({ headerHeight: 0, startMargin: 0 })
  // The list has something to show either when threads exist or when a search
  // is active (an empty result set still renders the "no matches" note).
  const hasListContent = chatThreads.length > 0 || Boolean(debouncedSearchQuery)

  // Virtua needs the height of non-virtual content before its rows so its
  // measurements stay aligned while the mobile controls stick over the list.
  useLayoutEffect(() => {
    if (!isMobile) {
      return
    }

    const elements = [mobileHeaderRef.current, mobileLabelRef.current].filter(
      (element): element is HTMLDivElement => element !== null,
    )
    const updateStartMargin = () => {
      const headerHeight = mobileHeaderRef.current?.offsetHeight ?? 0
      const startMargin = elements.reduce((height, element) => height + element.offsetHeight, 0)
      setMobileListMetrics((currentMetrics) =>
        currentMetrics.headerHeight === headerHeight && currentMetrics.startMargin === startMargin
          ? currentMetrics
          : { headerHeight, startMargin },
      )
    }
    const resizeObserver = new ResizeObserver(updateStartMargin)

    elements.forEach((element) => resizeObserver.observe(element))
    updateStartMargin()

    return () => resizeObserver.disconnect()
  }, [isMobile])

  const chatActions = (
    <ChatActions
      isCollapsed={isCollapsed}
      debouncedSearchQuery={debouncedSearchQuery}
      showSearch={showSearch}
      deleteAllChatsMutation={deleteAllChatsMutation}
      deleteAllChatsDialogRef={deleteAllChatsDialogRef}
      onSearchClick={onSearchClick}
    />
  )

  // overflow-hidden in BOTH states: while max-height animates, the input
  // would otherwise escape the shrinking/growing box and paint over the
  // first chat rows. Transition is scoped to the animated properties so
  // sidebar-width changes (rail collapse) don't ride along.
  const searchInput = (
    <div
      className={`overflow-hidden transition-[max-height,opacity,margin-top] duration-300 ease-in-out flex-shrink-0 ${
        showSearch && !isCollapsed && hasListContent ? 'max-h-12 opacity-100 mt-2' : 'max-h-0 opacity-0'
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
      <SidebarGroup className={cn('flex-1 flex flex-col min-h-0 pb-0', (isMobile || isCollapsed) && 'pt-0')}>
        {!isMobile && (
          <>
            {!isCollapsed && hasListContent && (
              <div className="flex items-center justify-between flex-shrink-0">
                <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
                {chatActions}
              </div>
            )}
            {searchInput}
          </>
        )}
        {isCollapsed && hasListContent && (
          <SidebarMenu className="flex-shrink-0">
            {/* Search works by expanding the sidebar to reveal the input, so
                it's hidden while a narrow window pins the sidebar collapsed. */}
            {!forceCollapsed && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={(e) => onSearchClick(e)}
                  tooltip="Search chats"
                  className="cursor-pointer text-muted-foreground hover:text-sidebar-foreground"
                >
                  <Search className={`size-[var(--icon-size-default)] ${debouncedSearchQuery ? 'text-primary' : ''}`} />
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => deleteAllChatsDialogRef.current?.open()}
                disabled={deleteAllChatsMutation.isPending}
                tooltip="Clear all chats"
                className="cursor-pointer text-muted-foreground hover:text-sidebar-foreground"
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
          </SidebarMenu>
        )}
        {isMobile && (
          <div
            ref={mobileHeaderRef}
            data-slot="mobile-sidebar-header"
            className="absolute inset-x-0 top-0 z-10 px-2 pt-[calc(var(--header-safe-area-top)+0.5rem)]"
          >
            <Scrim
              data-slot="mobile-sidebar-header-scrim"
              height="calc(100% + 2.5rem)"
              className="from-sidebar via-sidebar/80"
            />
            <div className="relative z-10">
              <div className="flex h-[var(--touch-height-lg)] flex-shrink-0 items-center justify-between">
                {mobileNavToggle}
                {hasListContent && chatActions}
              </div>
              {searchInput}
              {mobileSecondaryNavigation}
            </div>
          </div>
        )}
        <div
          ref={scrollContainerRef}
          data-slot="chat-list-scroll"
          className={cn(
            'mt-0 -mx-2 w-[calc(100%+1rem)] flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 scrollbar-hide touch-pan-y [overflow-anchor:none] md:mt-2 group-data-[collapsible=icon]:mt-0',
            isMobile && 'pb-[calc(var(--touch-height-lg)+0.5rem+var(--mobile-sidebar-footer-inset))]',
          )}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              data-slot="mobile-sidebar-header-spacer"
              style={{ height: mobileListMetrics.headerHeight }}
            />
          )}
          {isMobile && !isCollapsed && (
            <SidebarGroupLabel ref={mobileLabelRef} className="mt-1">
              {hasListContent ? 'Recent Chats' : 'No chats yet'}
            </SidebarGroupLabel>
          )}
          {/* No ssrCount here: virtua serves the unclamped [0, ssrCount) range
              until the first scroll event, so deleting rows below ssrCount
              before scrolling crashes it. Tests stub measurement instead
              (see test-utils/mock-virtua-measurement.ts). */}
          {chatThreads.length > 0 && (
            <Virtualizer
              scrollRef={scrollContainerRef}
              startMargin={isMobile ? mobileListMetrics.startMargin : undefined}
              as={VirtualChatMenu}
              item={VirtualChatRow}
            >
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
            </Virtualizer>
          )}
          {chatThreads.length === 0 && debouncedSearchQuery && !isCollapsed && (
            <div className="text-center text-sm py-12 px-4 text-muted-foreground">
              No matches for "{debouncedSearchQuery}"
            </div>
          )}
        </div>
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
