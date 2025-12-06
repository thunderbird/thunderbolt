import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Loader2, MessageCircle, MoreHorizontal } from 'lucide-react'
import type { ChatListItemProps } from './types'

export const ChatListItem = ({
  thread,
  isActive,
  isCollapsed,
  isMobile,
  deleteChatMutation,
  threadIdRef,
  deleteChatDialogRef,
  onChatClick,
}: ChatListItemProps) => {
  if (isCollapsed) {
    return (
      <SidebarMenuItem key={thread.id}>
        <SidebarMenuButton
          onClick={() => onChatClick(thread.id)}
          isActive={isActive}
          className="cursor-pointer"
          tooltip={thread.title ?? undefined}
        >
          <MessageCircle className="size-4 shrink-0" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <DropdownMenu key={thread.id}>
      <SidebarMenuItem className="group/item">
        <SidebarMenuButton
          onClick={() => onChatClick(thread.id)}
          isActive={isActive}
          className="cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground flex items-center gap-2"
        >
          <span className="truncate flex-1 min-w-0">{thread.title}</span>
          <DropdownMenuTrigger asChild>
            <MoreHorizontal
              className={cn(
                'shrink-0 size-4',
                !isMobile &&
                  'opacity-0 group-hover/item:opacity-100 group-data-[state=open]/item:opacity-100 transition-opacity',
              )}
            />
          </DropdownMenuTrigger>
        </SidebarMenuButton>
        <DropdownMenuContent side="right" align="start" className="min-w-56 rounded-lg">
          <DropdownMenuItem
            onClick={() => {
              threadIdRef.current = thread.id
              deleteChatDialogRef.current?.open()
            }}
            disabled={deleteChatMutation.isPending}
            className="text-destructive cursor-pointer"
          >
            {deleteChatMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Delete'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </SidebarMenuItem>
    </DropdownMenu>
  )
}
