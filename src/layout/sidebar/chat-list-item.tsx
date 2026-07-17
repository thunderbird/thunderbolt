/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Loader2, MessageCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { memo, useState } from 'react'
import type { ChatListItemProps } from './types'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat as useChat_default } from '@ai-sdk/react'
import { statusOnlyThrottleMs } from '@/chats/chat-throttle'
import { AnimatePresence, m } from 'framer-motion'
import { RenameChatDialog } from './rename-chat-dialog'

/** `useChat` is injectable so tests exercise the real component without a global
 *  `mock.module('@ai-sdk/react')` (which leaks across files under `--randomize`). */
type ChatListItemComponentProps = ChatListItemProps & {
  useChat?: typeof useChat_default
}

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
    useChat = useChat_default,
  }: ChatListItemComponentProps) => {
    const { chatInstance } = useChatStore(
      useShallow((state) => {
        const session = state.sessions.get(thread.id)

        return {
          chatInstance: session?.chatInstance,
        }
      }),
    )

    const { status } = useChat(
      chatInstance ? { chat: chatInstance, experimental_throttle: statusOnlyThrottleMs } : undefined,
    )
    const [renameDialogOpen, setRenameDialogOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [contextMenuOpen, setContextMenuOpen] = useState(false)
    const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null)
    const [prevTitle, setPrevTitle] = useState(thread.title)

    if (thread.title !== prevTitle) {
      setPrevTitle(thread.title)
      if (optimisticTitle !== null && thread.title === optimisticTitle) {
        setOptimisticTitle(null)
      }
    }

    const displayTitle = optimisticTitle ?? thread.title

    const handleRename = (title: string) => {
      setOptimisticTitle(title)
      onRename(thread.id, title)
    }

    if (isCollapsed) {
      return (
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => onChatClick(thread.id)}
            isActive={isActive}
            className="cursor-pointer"
            tooltip={thread.title ?? undefined}
          >
            {status === 'streaming' ? (
              <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
            ) : (
              <MessageCircle className="size-[var(--icon-size-default)] shrink-0" />
            )}
          </SidebarMenuButton>
        </SidebarMenuItem>
      )
    }

    const startRename = () => setRenameDialogOpen(true)
    const startDelete = () => {
      threadIdRef.current = thread.id
      deleteChatDialogRef.current?.open()
    }

    const deleteLabel = deleteChatMutation.isPending ? (
      <Loader2 className="size-4 animate-spin" />
    ) : (
      <>
        <Trash2 className="size-4 mr-2" />
        Delete
      </>
    )

    const anyMenuOpen = menuOpen || contextMenuOpen

    return (
      <>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <ContextMenu onOpenChange={setContextMenuOpen}>
            <SidebarMenuItem className="group/item">
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
                      {status === 'streaming' && (
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
                        !isMobile && !anyMenuOpen && 'opacity-0 group-hover/item:opacity-100 transition-opacity',
                      )}
                    />
                  </DropdownMenuTrigger>
                </SidebarMenuButton>
              </ContextMenuTrigger>

              {/* Right-click / touch long-press: a true context menu at the
                  cursor position. */}
              <ContextMenuContent className="min-w-56 rounded-xl">
                <ContextMenuItem onClick={startRename} className="cursor-pointer">
                  <Pencil className="size-4 mr-2" />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={startDelete}
                  disabled={deleteChatMutation.isPending}
                  className="cursor-pointer"
                >
                  {deleteLabel}
                </ContextMenuItem>
              </ContextMenuContent>

              {/* The trigger is the vertically-centered dots icon; the negative
                  alignOffset walks the menu back up so its top edge lines up with
                  the row's top edge (row is 32px on desktop, 44px on mobile;
                  icon is 16px). */}
              <DropdownMenuContent
                side="right"
                align="start"
                alignOffset={isMobile ? -14 : -8}
                className="min-w-56 rounded-xl"
              >
                <DropdownMenuItem onClick={startRename} className="cursor-pointer">
                  <Pencil className="size-4 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={startDelete}
                  disabled={deleteChatMutation.isPending}
                  className="cursor-pointer"
                >
                  {deleteLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </SidebarMenuItem>
          </ContextMenu>
        </DropdownMenu>
        <RenameChatDialog
          open={renameDialogOpen}
          title={thread.title}
          onOpenChange={setRenameDialogOpen}
          onRename={handleRename}
        />
      </>
    )
  },
)

ChatListItem.displayName = 'ChatListItem'
