/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarMenuButton } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Flame, Loader2, Search } from 'lucide-react'
import type { ChatActionsProps } from './types'

export const ChatActions = ({
  isCollapsed,
  debouncedSearchQuery,
  showSearch,
  deleteAllChatsMutation,
  deleteAllChatsDialogRef,
  onSearchClick,
}: ChatActionsProps) => {
  if (isCollapsed) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {/* Deliberately NO tooltip on the search button — the icon is
          self-explanatory. Do not re-add one "for consistency" with the
          clear-all button below (whose flame icon does need explaining);
          review passes have re-introduced it before. */}
      <SidebarMenuButton
        onClick={(e) => onSearchClick(e)}
        aria-label="Search chats"
        className={cn(
          'w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer',
          showSearch && 'bg-sidebar-accent',
          debouncedSearchQuery && 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary',
        )}
      >
        <Search className="size-4" />
      </SidebarMenuButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onClick={() => deleteAllChatsDialogRef.current?.open()}
            aria-label="Clear all chats"
            className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
            disabled={deleteAllChatsMutation.isPending}
          >
            {deleteAllChatsMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Flame className="size-4" />
            )}
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>Clear all chats</p>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
