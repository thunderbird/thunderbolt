/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chatTitleLabel } from '@/lib/title-generator'

import { Trans, useLingui } from '@lingui/react/macro'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ResponsiveActionMenu } from '@/components/ui/responsive-action-menu'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { useLongPress } from '@/hooks/use-long-press'
import { useDraggable } from '@dnd-kit/core'
import { chatDragId, type ChatDragData } from '@/projects/chat-drop'
import { cn } from '@/lib/utils'
import { FolderInput, Loader2, MessageCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { memo, useReducer, useRef, type ComponentType, type MouseEventHandler, type ReactNode } from 'react'
import type { ChatListItemProps } from './types'
import { useChatStore } from '@/chats/chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { statusOnlyThrottleMs } from '@/chats/chat-throttle'
import { AnimatePresence, m } from 'framer-motion'
import { RenameChatDialog } from './rename-chat-dialog'

/** `useChat` is injectable so tests exercise the real component without a global
 *  `mock.module('@ai-sdk/react')` (which leaks across files under `--randomize`). */
type ChatListItemComponentProps = ChatListItemProps & {
  useChat?: typeof useChat_default
}

type ChatItemMenu = 'dropdown' | 'context' | 'mobile'

type ChatListItemState = {
  renameDialogOpen: boolean
  openMenu: ChatItemMenu | null
  optimisticTitle: string | null
  observedTitle: string | null
}

type ChatListItemAction =
  | { type: 'MENU_CHANGED'; menu: ChatItemMenu; open: boolean }
  | { type: 'RENAME_DIALOG_CHANGED'; open: boolean }
  | { type: 'RENAMED'; title: string }
  | { type: 'THREAD_TITLE_CHANGED'; title: string | null }

const createChatListItemState = (title: string | null): ChatListItemState => ({
  renameDialogOpen: false,
  openMenu: null,
  optimisticTitle: null,
  observedTitle: title,
})

const chatListItemReducer = (state: ChatListItemState, action: ChatListItemAction): ChatListItemState => {
  switch (action.type) {
    case 'MENU_CHANGED':
      return {
        ...state,
        openMenu: action.open ? action.menu : state.openMenu === action.menu ? null : state.openMenu,
      }
    case 'RENAME_DIALOG_CHANGED':
      return { ...state, renameDialogOpen: action.open }
    case 'RENAMED':
      return { ...state, optimisticTitle: action.title }
    case 'THREAD_TITLE_CHANGED':
      return { ...state, observedTitle: action.title, optimisticTitle: null }
  }
}

/** Centralizes a chat row's menu, rename, and optimistic-title state. */
const useChatListItemState = (threadTitle: string | null) => {
  const [state, dispatch] = useReducer(chatListItemReducer, threadTitle, createChatListItemState)

  if (threadTitle !== state.observedTitle) {
    dispatch({ type: 'THREAD_TITLE_CHANGED', title: threadTitle })
  }

  return [state, dispatch] as const
}

type MenuItemComponent = ComponentType<{
  onClick?: MouseEventHandler
  disabled?: boolean
  className?: string
  children?: ReactNode
}>

/** The same Rename/Delete actions back the context menu and desktop `⋯`
 *  dropdown — only the Radix item primitive differs. */
const ChatItemActions = ({
  Item,
  onRename,
  onMove,
  onDelete,
  deleteLabel,
  isDeletePending,
}: {
  Item: MenuItemComponent
  onRename: () => void
  onMove: () => void
  onDelete: () => void
  deleteLabel: ReactNode
  isDeletePending: boolean
}) => (
  <>
    <Item onClick={onRename} className="cursor-pointer">
      <Pencil className="size-4 mr-2" />
      <Trans>Rename</Trans>
    </Item>
    <Item onClick={onMove} className="cursor-pointer">
      <FolderInput className="size-4 mr-2" />
      <Trans>Move to project</Trans>
    </Item>
    <Item onClick={onDelete} disabled={isDeletePending} className="cursor-pointer">
      {deleteLabel}
    </Item>
  </>
)

export const ChatListItem = memo(
  ({
    thread,
    isActive,
    isCollapsed,
    isMobile,
    deleteChatMutation,
    threadIdRef,
    deleteChatDialogRef,
    onChatClick,
    onRename,
    onMoveToProject,
    useChat = useChat_default,
  }: ChatListItemComponentProps) => {
    const { i18n, t } = useLingui()
    const chatInstance = useChatStore((state) => state.sessions.get(thread.id)?.chatInstance)

    const { status } = useChat(
      chatInstance ? { chat: chatInstance, experimental_throttle: statusOnlyThrottleMs } : undefined,
    )
    const [{ renameDialogOpen, openMenu, optimisticTitle }, dispatch] = useChatListItemState(thread.title)
    const isOpeningDialogRef = useRef(false)
    const longPressFiredRef = useRef(false)
    const mobileLongPressHandlers = useLongPress(() => {
      longPressFiredRef.current = true
      dispatch({ type: 'MENU_CHANGED', menu: 'mobile', open: true })
    })

    const {
      attributes: dragAttributes,
      listeners: dragListeners,
      setNodeRef: setDragRef,
      isDragging,
    } = useDraggable({
      id: chatDragId(thread.id),
      // Carried on the drag so the sidebar can render a preview and decide
      // whether "Remove from project" applies, with no extra query.
      data: { title: thread.title, projectId: thread.projectId ?? null } satisfies ChatDragData,
    })

    const displayTitle = optimisticTitle ?? chatTitleLabel(i18n, thread.title)

    const handleRename = (title: string) => {
      dispatch({ type: 'RENAMED', title })
      onRename(thread.id, title)
    }

    const showSpinner = status === 'streaming'

    if (isCollapsed) {
      return (
        <SidebarMenuButton
          onClick={() => onChatClick(thread.id)}
          isActive={isActive}
          className="cursor-pointer"
          tooltip={chatTitleLabel(i18n, thread.title)}
        >
          {showSpinner ? (
            <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
          ) : (
            <MessageCircle className="size-[var(--icon-size-default)] shrink-0" />
          )}
        </SidebarMenuButton>
      )
    }

    const startRename = () => {
      isOpeningDialogRef.current = true
      dispatch({ type: 'RENAME_DIALOG_CHANGED', open: true })
    }
    // The picker is owned by the sidebar: one dialog for the whole list rather
    // than one per row, and it needs the database context that a row does not.
    const startMove = () => {
      isOpeningDialogRef.current = true
      onMoveToProject(thread.id, thread.projectId ?? null)
    }
    const startDelete = () => {
      isOpeningDialogRef.current = true
      threadIdRef.current = thread.id
      deleteChatDialogRef.current?.open()
    }

    const deleteIcon = deleteChatMutation.isPending ? (
      <Loader2 className="size-4 animate-spin" />
    ) : (
      <Trash2 className="size-4" />
    )
    const deleteLabel = deleteChatMutation.isPending ? (
      deleteIcon
    ) : (
      <>
        <Trash2 className="size-4 mr-2" />
        <Trans>Delete</Trans>
      </>
    )

    const anyMenuOpen = openMenu !== null
    // A close event may arrive after the *other* menu already claimed the
    // slot (opening one dismisses the other), so only the current owner may
    // clear it.
    const handleMenuOpenChange = (menu: ChatItemMenu) => (open: boolean) =>
      dispatch({ type: 'MENU_CHANGED', menu, open })
    // A closing menu normally restores focus to its trigger after the newly
    // opened rename surface has focused its input, which would hide the keyboard.
    const handleMenuCloseAutoFocus = (event: Event) => {
      if (!isOpeningDialogRef.current) {
        return
      }
      event.preventDefault()
      isOpeningDialogRef.current = false
    }

    const renameDialog = (
      <RenameChatDialog
        open={renameDialogOpen}
        title={thread.title}
        onOpenChange={(open) => dispatch({ type: 'RENAME_DIALOG_CHANGED', open })}
        onRename={handleRename}
      />
    )

    if (isMobile) {
      const trigger = (
        <SidebarMenuButton
          {...mobileLongPressHandlers}
          data-long-press=""
          onClick={() => {
            if (longPressFiredRef.current) {
              longPressFiredRef.current = false
              return
            }
            onChatClick(thread.id)
          }}
          isActive={isActive}
          className={cn(
            'flex cursor-pointer items-center gap-2',
            anyMenuOpen && 'bg-sidebar-accent text-sidebar-accent-foreground',
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showSpinner && (
              <Loader2 className="size-[var(--icon-size-default)] shrink-0 animate-spin text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
          </div>
        </SidebarMenuButton>
      )

      return (
        <>
          <ResponsiveActionMenu
            open={openMenu === 'mobile'}
            onOpenChange={handleMenuOpenChange('mobile')}
            trigger={trigger}
            title={displayTitle ?? t`Chat actions`}
            openOnTriggerClickMobile={false}
            actions={[
              {
                label: t`Rename`,
                icon: <Pencil className="size-4" />,
                onSelect: startRename,
              },
              {
                label: t`Move to project`,
                icon: <FolderInput className="size-4" />,
                onSelect: startMove,
              },
              {
                label: t`Delete`,
                icon: deleteIcon,
                onSelect: startDelete,
                disabled: deleteChatMutation.isPending,
              },
            ]}
          />
          {renameDialog}
        </>
      )
    }

    return (
      <>
        <DropdownMenu open={openMenu === 'dropdown'} onOpenChange={handleMenuOpenChange('dropdown')}>
          <ContextMenu onOpenChange={handleMenuOpenChange('context')}>
            {/* The list `li` is provided by the virtualized row wrapper in
                chat-list.tsx; this div carries the group classes the menu
                button's hover/action styles key off. */}
            <div
              data-sidebar="menu-item"
              // Draggable so the chat can be dropped onto a project row. The
              // sensor in `ChatSidebarContent` requires 8px of movement before a
              // drag starts, so ordinary clicks, the context menu, and the mobile
              // long-press all keep working.
              ref={setDragRef}
              {...dragListeners}
              {...dragAttributes}
              className={cn('group/menu-item group/item relative', isDragging && 'opacity-50')}
            >
              <ContextMenuTrigger asChild>
                <SidebarMenuButton
                  onClick={() => onChatClick(thread.id)}
                  isActive={isActive}
                  className={cn(
                    'cursor-pointer flex items-center gap-2',
                    // Radix puts data-state on the triggers, not this button, so
                    // the open-state highlight is driven by our own state.
                    anyMenuOpen && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  )}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <AnimatePresence>
                      {showSpinner && (
                        <m.div
                          key={`${thread.id}-loading`}
                          initial={{ opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: 'auto' }}
                          exit={{ opacity: 0, width: 0 }}
                          className="flex-shrink-0"
                        >
                          <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
                        </m.div>
                      )}
                    </AnimatePresence>
                    <span className="truncate flex-1 min-w-0">{displayTitle}</span>
                  </div>
                  <DropdownMenuTrigger asChild>
                    <MoreHorizontal
                      className={cn(
                        'shrink-0 size-4',
                        !anyMenuOpen && 'opacity-0 group-hover/item:opacity-100 transition-opacity',
                      )}
                    />
                  </DropdownMenuTrigger>
                </SidebarMenuButton>
              </ContextMenuTrigger>

              {/* Right-click / touch long-press: a true context menu at the
                  cursor position. */}
              <ContextMenuContent className="min-w-56" onCloseAutoFocus={handleMenuCloseAutoFocus}>
                <ChatItemActions
                  Item={ContextMenuItem}
                  onRename={startRename}
                  onMove={startMove}
                  onDelete={startDelete}
                  deleteLabel={deleteLabel}
                  isDeletePending={deleteChatMutation.isPending}
                />
              </ContextMenuContent>

              <DropdownMenuContent
                side="right"
                align="start"
                alignOffset={-8}
                className="min-w-56"
                onCloseAutoFocus={handleMenuCloseAutoFocus}
              >
                <ChatItemActions
                  Item={DropdownMenuItem}
                  onRename={startRename}
                  onMove={startMove}
                  onDelete={startDelete}
                  deleteLabel={deleteLabel}
                  isDeletePending={deleteChatMutation.isPending}
                />
              </DropdownMenuContent>
            </div>
          </ContextMenu>
        </DropdownMenu>
        {renameDialog}
      </>
    )
  },
)

ChatListItem.displayName = 'ChatListItem'
