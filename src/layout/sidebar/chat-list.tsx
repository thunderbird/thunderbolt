/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Flame, Plus } from 'lucide-react'
import { DeleteAllChatsDialog } from '@/components/delete-all-chats-dialog'
import { DeleteChatDialog } from '@/components/delete-chat-dialog'
import { SidebarGroup, SidebarMenu, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { cn } from '@/lib/utils'
import { type Ref, type RefObject } from 'react'
import { Virtualizer, type CustomContainerComponentProps, type CustomItemComponentProps } from 'virtua'
import { ChatListItem } from './chat-list-item'
import type { ChatListProps } from './types'
import { recentChatsPreviewCount, useSidebarPreviewState } from './use-sidebar-preview-state'
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
  scrollRef,
}: ChatListProps & { scrollRef: RefObject<HTMLDivElement | null> }) => {
  const { t } = useLingui()
  const createNewChat = useCreateNewChat()
  const { closeMobileSidebar } = useSidebar()
  const shared = useSharedChatListMetrics(isCollapsed ? undefined : scrollRef)
  const preview = useSidebarPreviewState(chatThreads, currentChatThreadId, recentChatsPreviewCount)
  const [storedExpanded, setSectionExpanded] = useLocalStorage('sidebar.recents.expanded', 'true')
  const sectionExpanded = storedExpanded !== 'false'
  const hasListContent = chatThreads.length > 0
  const sectionToggle = (
    <SidebarSectionToggle
      expanded={sectionExpanded}
      onToggle={() => setSectionExpanded(sectionExpanded ? 'false' : 'true')}
      controls="sidebar-recent-chats-content"
      label={t`Recents`}
      optionsLabel={t`Recent chat options`}
      actions={[
        {
          label: t`New chat`,
          icon: <Plus className="size-4" />,
          onSelect: async () => {
            await closeMobileSidebar()
            createNewChat()
          },
        },
        {
          label: t`Delete chats`,
          icon: <Flame className="size-4" />,
          disabled: deleteAllChatsMutation.isPending,
          onSelect: () => deleteAllChatsDialogRef.current?.open(),
        },
      ]}
    />
  )

  const mobileChrome = (
    <div data-slot="mobile-sidebar-header" className="relative z-10 pt-[calc(var(--header-safe-area-top)+0.5rem)]">
      <div className="flex h-[var(--touch-height-lg)] shrink-0 items-center">{mobileNavToggle}</div>
      {mobileSecondaryNavigation}
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
  ) : hasListContent ? (
    sectionToggle
  ) : null

  return (
    <>
      <SidebarGroup className={cn('flex shrink-0 flex-col pb-0', (isMobile || isCollapsed) && 'pt-0')}>
        {isMobile ? mobileChrome : desktopChrome}
        <div hidden={isCollapsed} id="sidebar-recent-chats" data-slot="chat-list">
          {isMobile &&
            (hasListContent ? (
              sectionToggle
            ) : (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                <Trans>No chats yet</Trans>
              </p>
            ))}
          {/* No ssrCount here: virtua serves the unclamped [0, ssrCount) range
              until the first scroll event, so deleting rows below ssrCount
              before scrolling crashes it. Tests stub measurement instead
              (see test-utils/mock-virtua-measurement.ts). */}
          <div ref={shared.listRef} id="sidebar-recent-chats-content" hidden={!sectionExpanded}>
            {!isCollapsed && chatThreads.length > 0 && (
              <Virtualizer
                scrollRef={scrollRef}
                startMargin={shared.startMargin}
                as={VirtualChatMenu}
                item={VirtualChatRow}
              >
                {preview.items.map((thread) => (
                  <ChatListItem
                    key={thread.id}
                    thread={thread}
                    isActive={thread.id === currentChatThreadId}
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
            {!isCollapsed && preview.hasOverflow && (
              <SidebarMenu className="mt-1">
                <SidebarMenuItem>
                  <SidebarListToggle
                    showAll={preview.showAll}
                    onToggle={preview.toggle}
                    controls="sidebar-recent-chats"
                    label={preview.showAll ? t`Show fewer recent chats` : t`Show more recent chats`}
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
