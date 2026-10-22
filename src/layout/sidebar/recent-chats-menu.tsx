/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Flame, Loader2, MessageCircle, Plus } from 'lucide-react'
import { useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { ChatMenuItems } from './chat-menu-items'
import type { ChatListProps } from './types'

/** Keep recent chats and their bulk action inside one collapsed-rail menu. */
export const RecentChatsMenu = ({
  chatThreads,
  currentChatThreadId,
  onChatClick,
  deleteAllChatsDialogRef,
  deleteAllChatsMutation,
}: Pick<
  ChatListProps,
  'chatThreads' | 'currentChatThreadId' | 'onChatClick' | 'deleteAllChatsDialogRef' | 'deleteAllChatsMutation'
>) => {
  const { t } = useLingui()
  const createNewChat = useCreateNewChat()
  const openingDialog = useRef(false)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          tooltip={t`Recents`}
          aria-label={t`Recents`}
          isActive={chatThreads.some((thread) => thread.id === currentChatThreadId)}
        >
          <MessageCircle />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72"
        onCloseAutoFocus={(event) => {
          if (openingDialog.current) {
            event.preventDefault()
            openingDialog.current = false
          }
        }}
      >
        <div className="flex items-center justify-between">
          <DropdownMenuLabel className="text-muted-foreground">
            <Trans>Recents</Trans>
          </DropdownMenuLabel>
          {chatThreads.length > 0 && (
            <DropdownMenuItem
              aria-label={t`Delete chats outside projects`}
              className="size-[var(--touch-height-lg)] shrink-0 cursor-pointer justify-center rounded-xl p-2 text-muted-foreground hover:text-sidebar-foreground md:size-8"
              disabled={deleteAllChatsMutation.isPending}
              onSelect={() => {
                openingDialog.current = true
                deleteAllChatsDialogRef.current?.open()
              }}
            >
              {deleteAllChatsMutation.isPending ? (
                <Loader2 className="size-[var(--icon-size-default)] animate-spin" />
              ) : (
                <Flame className="size-[var(--icon-size-default)]" />
              )}
            </DropdownMenuItem>
          )}
        </div>
        <ChatMenuItems chatThreads={chatThreads} currentChatThreadId={currentChatThreadId} onChatClick={onChatClick} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={createNewChat}>
          <Plus />
          <Trans>New chat</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
