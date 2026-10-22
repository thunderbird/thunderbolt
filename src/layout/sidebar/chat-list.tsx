/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DeleteAllChatsDialog } from '@/components/delete-all-chats-dialog'
import { DeleteChatDialog } from '@/components/delete-chat-dialog'
import { MobileSidebarScrim } from '@/components/ui/scrim'
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'
import { Virtualizer, type CustomContainerComponentProps, type CustomItemComponentProps } from 'virtua'
import { ChatActions } from './chat-actions'
import { ChatListItem } from './chat-list-item'
import type { ChatListProps } from './types'
import { useSidebarPreviewState } from './use-sidebar-preview-state'
import { useSharedChatListMetrics } from './use-shared-chat-list-metrics'
import { SidebarListToggle } from './sidebar-list-toggle'
import { SidebarSectionToggle } from './sidebar-section-toggle'
import { RecentChatsMenu } from './recent-chats-menu'

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

/**
 * Measures the mobile sticky chrome (pinned header + list label) so virtua
 * can offset its rows below the non-virtual content. Both measured elements
 * are always mounted while `isMobile` is true, so the observer never watches
 * a detached node.
 */
const useMobileListMetrics = (isMobile: boolean) => {
  const headerRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ headerHeight: 0, startMargin: 0 })

  useLayoutEffect(() => {
    if (!isMobile) {
      return
    }

    const header = headerRef.current
    const label = labelRef.current
    if (!header || !label) {
      throw new Error('useMobileListMetrics: measured mobile chrome is not mounted')
    }
    const updateStartMargin = () => {
      const headerHeight = header.offsetHeight
      const startMargin = header.offsetHeight + label.offsetHeight
      setMetrics((currentMetrics) =>
        currentMetrics.headerHeight === headerHeight && currentMetrics.startMargin === startMargin
          ? currentMetrics
          : { headerHeight, startMargin },
      )
    }
    const resizeObserver = new ResizeObserver(updateStartMargin)

    resizeObserver.observe(header)
    resizeObserver.observe(label)
    updateStartMargin()

    return () => resizeObserver.disconnect()
  }, [isMobile])

  return { headerRef, labelRef, metrics }
}

export const ChatList = ({
  chatThreads,
  currentChatThreadId,
  isCollapsed,
  isMobile,
  deleteAllChatsMutation,
  deleteChatMutation,
  deleteAllChatsDialogRef,
  deleteChatDialogRef,
  threadIdRef,
  mobileNavToggle,
  mobileSecondaryNavigation,
  onChatClick,
  onRename,
  onMoveToProject,
  onSearchClick,
  sharedScrollRef,
}: ChatListProps & { sharedScrollRef?: RefObject<HTMLDivElement | null> }) => {
  const { t } = useLingui()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const shared = useSharedChatListMetrics(isCollapsed ? undefined : sharedScrollRef)
  const preview = useSidebarPreviewState(chatThreads, currentChatThreadId)
  const [sectionExpanded, setSectionExpanded] = useState(true)
  const showChats = !sharedScrollRef || isCollapsed || sectionExpanded
  const visibleChats = sharedScrollRef ? preview.items : chatThreads
  const {
    headerRef: mobileHeaderRef,
    labelRef: mobileLabelRef,
    metrics: mobileListMetrics,
  } = useMobileListMetrics(isMobile && !sharedScrollRef)
  const hasListContent = chatThreads.length > 0
  const sectionToggle = (
    <SidebarSectionToggle
      expanded={sectionExpanded}
      onToggle={() => setSectionExpanded((expanded) => !expanded)}
      controls="sidebar-recent-chats-content"
    >
      <Trans>Recents</Trans>
    </SidebarSectionToggle>
  )

  const chatActions = (
    <ChatActions
      showSearch={!sharedScrollRef}
      isCollapsed={isCollapsed}
      showClearAll={hasListContent}
      deleteAllChatsMutation={deleteAllChatsMutation}
      deleteAllChatsDialogRef={deleteAllChatsDialogRef}
      onSearchClick={onSearchClick}
    />
  )

  // Mobile: a pinned, measured header floats over the list (nav toggle,
  // actions and secondary nav) and the list starts below it.
  const mobileChrome = (
    <div
      ref={mobileHeaderRef}
      data-slot="mobile-sidebar-header"
      className={cn(
        'z-10 px-2 pt-[calc(var(--header-safe-area-top)+0.5rem)]',
        sharedScrollRef ? 'relative' : 'absolute inset-x-0 top-0',
      )}
    >
      {!sharedScrollRef && <MobileSidebarScrim data-slot="mobile-sidebar-header-scrim" />}
      <div className="relative z-10">
        <div
          className={cn(
            'flex h-[var(--touch-height-lg)] flex-shrink-0 items-center',
            // With no section toggle (minimal mode) the actions keep to the right.
            mobileNavToggle ? 'justify-between' : 'justify-end',
          )}
        >
          {mobileNavToggle}
          {chatActions}
        </div>
        {mobileSecondaryNavigation}
      </div>
    </div>
  )

  // Collapsed navigation keeps all recent chats behind one rail button.
  const desktopChrome = isCollapsed ? (
    <SidebarMenu className="flex-shrink-0">
      <SidebarMenuItem>
        <RecentChatsMenu
          chatThreads={chatThreads}
          currentChatThreadId={currentChatThreadId}
          onChatClick={onChatClick}
          deleteAllChatsMutation={deleteAllChatsMutation}
          deleteAllChatsDialogRef={deleteAllChatsDialogRef}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  ) : (
    <div className="flex items-center justify-between flex-shrink-0">
      {hasListContent ? (
        sharedScrollRef ? (
          sectionToggle
        ) : (
          <SidebarGroupLabel>
            <Trans>Recents</Trans>
          </SidebarGroupLabel>
        )
      ) : (
        <span aria-hidden />
      )}
      {chatActions}
    </div>
  )

  return (
    <>
      <SidebarGroup
        className={cn(
          'flex flex-col pb-0',
          sharedScrollRef ? 'shrink-0' : 'flex-1 min-h-0',
          (isMobile || isCollapsed) && 'pt-0',
        )}
      >
        {isMobile ? mobileChrome : desktopChrome}
        <div
          hidden={isCollapsed}
          ref={sharedScrollRef ? undefined : scrollContainerRef}
          id="sidebar-recent-chats"
          data-slot={sharedScrollRef ? 'chat-list' : 'chat-list-scroll'}
          className={cn(
            'mt-0 group-data-[collapsible=icon]:mt-0',
            showChats && 'md:mt-2',
            !sharedScrollRef &&
              '-mx-2 w-[calc(100%+1rem)] flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 scrollbar-hide touch-pan-y [overflow-anchor:none]',
            // Bottom padding = footer control height + the footer's 0.5rem
            // gap above it + the safe-area inset, so the last row clears the
            // pinned footer.
            isMobile &&
              !sharedScrollRef &&
              'pb-[calc(var(--touch-height-lg)+0.5rem+var(--mobile-sidebar-footer-inset))]',
          )}
        >
          {/* The measured spacer keeps rows below the pinned header; the label
              scrolls with the list. (The sidebar is never collapsed on mobile,
              so no isCollapsed check here.) */}
          {isMobile && (
            <>
              {!sharedScrollRef && (
                <div
                  aria-hidden="true"
                  data-slot="mobile-sidebar-header-spacer"
                  style={{ height: mobileListMetrics.headerHeight }}
                />
              )}
              {sharedScrollRef && hasListContent ? (
                sectionToggle
              ) : (
                <SidebarGroupLabel ref={mobileLabelRef} className="mt-1">
                  {hasListContent ? <Trans>Recents</Trans> : <Trans>No chats yet</Trans>}
                </SidebarGroupLabel>
              )}
            </>
          )}
          {/* No ssrCount here: virtua serves the unclamped [0, ssrCount) range
              until the first scroll event, so deleting rows below ssrCount
              before scrolling crashes it. Tests stub measurement instead
              (see test-utils/mock-virtua-measurement.ts). */}
          <div ref={shared.listRef} id="sidebar-recent-chats-content" hidden={!showChats}>
            {!isCollapsed && chatThreads.length > 0 && (
              <Virtualizer
                scrollRef={sharedScrollRef ?? scrollContainerRef}
                startMargin={
                  sharedScrollRef ? shared.startMargin : isMobile ? mobileListMetrics.startMargin : undefined
                }
                as={VirtualChatMenu}
                item={VirtualChatRow}
              >
                {visibleChats.map((thread) => (
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
                    onMoveToProject={onMoveToProject}
                  />
                ))}
              </Virtualizer>
            )}
            {!isCollapsed && sharedScrollRef && preview.hasOverflow && (
              <SidebarMenu className="mt-1">
                <SidebarMenuItem>
                  <SidebarListToggle
                    iconPosition="end"
                    showAll={preview.showAll}
                    onToggle={preview.toggle}
                    controls="sidebar-recent-chats"
                    label={preview.showAll ? t`Show fewer recent chats` : t`Show more recent chats`}
                    isCollapsed={isCollapsed}
                  />
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </div>
        </div>
      </SidebarGroup>

      <DeleteAllChatsDialog
        isPending={deleteAllChatsMutation.isPending}
        onConfirm={() => deleteAllChatsMutation.mutate()}
        ref={deleteAllChatsDialogRef}
      />
      <DeleteChatDialog
        isPending={deleteChatMutation.isPending}
        onCancel={() => {
          threadIdRef.current = null
        }}
        onConfirm={() => {
          const threadId = threadIdRef.current
          // The ref is always set before the dialog opens, so a missing id is
          // a programming error — fail loudly rather than no-op.
          if (!threadId) {
            throw new Error('DeleteChatDialog confirmed without a target thread id')
          }
          deleteChatMutation.mutate({ id: threadId })
        }}
        ref={deleteChatDialogRef}
      />
    </>
  )
}
