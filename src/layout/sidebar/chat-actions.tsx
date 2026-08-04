/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarMenuButton } from '@/components/ui/sidebar'
import { Flame, Loader2, Search } from 'lucide-react'
import type { ChatActionsProps } from './types'

const actionButtonClass =
  'size-[var(--touch-height-lg)] md:size-8 items-center justify-center cursor-pointer text-muted-foreground hover:text-sidebar-foreground'

export const ChatActions = ({
  isCollapsed,
  showClearAll,
  deleteAllChatsMutation,
  deleteAllChatsDialogRef,
  onSearchClick,
}: ChatActionsProps) => {
  if (isCollapsed) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <SidebarMenuButton onClick={onSearchClick} aria-label="Search" className={actionButtonClass}>
        <Search className="size-[var(--icon-size-default)]" />
      </SidebarMenuButton>
      {showClearAll && (
        <SidebarMenuButton
          onClick={() => deleteAllChatsDialogRef.current?.open()}
          aria-label="Clear all chats"
          className={actionButtonClass}
          disabled={deleteAllChatsMutation.isPending}
        >
          {deleteAllChatsMutation.isPending ? (
            <Loader2 className="size-[var(--icon-size-default)] animate-spin" />
          ) : (
            <Flame className="size-[var(--icon-size-default)]" />
          )}
        </SidebarMenuButton>
      )}
    </div>
  )
}
