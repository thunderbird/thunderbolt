import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Loader2, MessageCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { ChatListItemProps } from './types'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat } from '@ai-sdk/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatListItemState } from './use-chat-list-item-state'
import { memo } from 'react'

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
  }: ChatListItemProps) => {
    const { chatInstance } = useChatStore(
      useShallow((state) => {
        const session = state.sessions.get(thread.id)

        return {
          chatInstance: session?.chatInstance,
        }
      }),
    )

    const { status } = useChat(chatInstance ? { chat: chatInstance } : undefined)

    const {
      isEditing,
      editValue,
      setEditValue,
      displayTitle,
      inputRef,
      handleRenameStart,
      handleRenameSubmit,
      handleRenameCancel,
    } = useChatListItemState({
      title: thread.title,
      onRename: (title) => onRename(thread.id, title),
    })

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

    return (
      <DropdownMenu>
        <SidebarMenuItem className="group/item">
          <SidebarMenuButton
            onClick={() => !isEditing && onChatClick(thread.id)}
            isActive={isActive}
            className={cn(
              'cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground flex items-center gap-2',
              isEditing && 'bg-background hover:bg-background',
            )}
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <AnimatePresence>
                {status === 'streaming' && (
                  <motion.div
                    key={`${thread.id}-loading`}
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 'auto' }}
                    exit={{ opacity: 0, width: 0 }}
                    className="flex-shrink-0"
                  >
                    <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
                  </motion.div>
                )}
              </AnimatePresence>
              {isEditing ? (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleRenameSubmit()
                    } else if (e.key === 'Escape') {
                      handleRenameCancel()
                    }
                  }}
                  onBlur={handleRenameSubmit}
                  onClick={(e) => e.stopPropagation()}
                  enterKeyHint="done"
                  autoComplete="off"
                  className="truncate flex-1 min-w-0 bg-transparent outline-none text-sm"
                />
              ) : (
                <span className="truncate flex-1 min-w-0">{displayTitle}</span>
              )}
            </div>
            {!isEditing && (
              <DropdownMenuTrigger asChild>
                <MoreHorizontal
                  className={cn(
                    'shrink-0 size-4',
                    !isMobile &&
                      'opacity-0 group-hover/item:opacity-100 group-data-[state=open]/item:opacity-100 transition-opacity',
                  )}
                />
              </DropdownMenuTrigger>
            )}
          </SidebarMenuButton>
          <DropdownMenuContent side="right" align="start" className="min-w-56 rounded-lg">
            <DropdownMenuItem onClick={handleRenameStart} className="cursor-pointer">
              <Pencil className="size-4 mr-2" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                threadIdRef.current = thread.id
                deleteChatDialogRef.current?.open()
              }}
              disabled={deleteChatMutation.isPending}
              className="cursor-pointer"
            >
              {deleteChatMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
                  Delete
                </>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </SidebarMenuItem>
      </DropdownMenu>
    )
  },
)

ChatListItem.displayName = 'ChatListItem'
