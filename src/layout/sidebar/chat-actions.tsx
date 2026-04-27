/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarMenuButton } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Flame, Loader2, Search } from 'lucide-react'
import type { ChatActionsProps } from './types'

export const ChatActions = ({
  isCollapsed,
  debouncedSearchQuery,
  deleteAllChatsMutation,
  deleteAllChatsDialogRef,
  onSearchClick,
}: ChatActionsProps) => {
  if (isCollapsed) {
    return null
  }

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onClick={(e) => onSearchClick(e)}
            className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
          >
            <Search className={`size-4 ${debouncedSearchQuery ? 'text-blue-500' : ''}`} />
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>Search chats</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onClick={() => deleteAllChatsDialogRef.current?.open()}
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
