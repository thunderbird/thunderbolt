import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { Loader2, Lock, MessageCircle, MoreHorizontal } from 'lucide-react'
import type { ChatListItemProps } from './types'

export const ChatListItem = ({
  thread,
  isActive,
  isCollapsed,
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
          tooltip={{
            children: (
              <div className="flex items-center gap-2">
                {Boolean(thread.isEncrypted) && <Lock className="size-3.5" />}
                <p>{thread.title}</p>
              </div>
            ),
          }}
        >
          <MessageCircle className="size-4 shrink-0" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <DropdownMenu key={thread.id}>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => onChatClick(thread.id)}
          isActive={isActive}
          className="cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground flex items-center gap-2"
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {thread.isEncrypted ? <Lock className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{thread.title}</span>
          </div>
          <DropdownMenuTrigger asChild>
            <MoreHorizontal className="shrink-0 size-4" />
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
