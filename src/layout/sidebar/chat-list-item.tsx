import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Loader2, MessageCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { ChatListItemProps } from './types'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat } from '@ai-sdk/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

export const ChatListItem = ({
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

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!isEditing) {
      return
    }
    // Small delay to ensure dropdown has fully closed before focusing
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(timer)
  }, [isEditing])

  const handleRenameStart = () => {
    setEditValue(thread.title ?? 'New Chat')
    setIsEditing(true)
  }

  const handleRenameSubmit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    const trimmed = editValue.trim()
    const title = trimmed || 'New Chat'
    if (title !== (thread.title ?? 'New Chat')) {
      onRename(thread.id, title)
    }
    setIsEditing(false)
  }

  const handleRenameCancel = () => {
    cancelledRef.current = true
    setIsEditing(false)
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
            <Loader2 className={`h-4 w-4 animate-spin text-muted-foreground`} />
          ) : (
            <MessageCircle className="size-4 shrink-0" />
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
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
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
                className={cn(
                  'truncate flex-1 min-w-0 bg-transparent outline-none border-b-2 text-sm pb-px transition-colors',
                  editValue !== (thread.title ?? 'New Chat') ? 'border-blue-500' : 'border-transparent',
                )}
              />
            ) : (
              <span className="truncate flex-1 min-w-0">{thread.title}</span>
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
            className="text-destructive cursor-pointer"
          >
            {deleteChatMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <Trash2 className="size-4 mr-2 text-destructive" />
                Delete
              </>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </SidebarMenuItem>
    </DropdownMenu>
  )
}
