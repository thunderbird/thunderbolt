/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useDatabase } from '@/contexts'
import { getAllChatThreads } from '@/dal'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import type { SearchEntityType } from '../types'
import { entityIcons } from './entity-meta'

const recentChatsLimit = 8
const ChatIcon = entityIcons.chat

/**
 * The palette's zero-query state: the most recent chats (already recent-first
 * from the DAL), each navigating to its thread.
 */
export const RecentChatsGroup = ({ onSelect }: { onSelect: (to: string, entityType: SearchEntityType) => void }) => {
  const db = useDatabase()
  const { data } = useQuery({
    queryKey: ['searchPaletteRecentChats'],
    query: toCompilableQuery(getAllChatThreads(db)),
    placeholderData: (previousData) => previousData,
  })

  const recentChats = (data ?? []).slice(0, recentChatsLimit)
  if (recentChats.length === 0) {
    return null
  }

  return (
    <CommandGroup heading="Recent">
      {recentChats.map((chat) => (
        <CommandItem
          key={chat.id}
          value={`${chat.title ?? ''} ${chat.id}`}
          onSelect={() => onSelect(`/chats/${chat.id}`, 'chat')}
          className="gap-2 rounded-md"
        >
          <ChatIcon className="size-[var(--icon-size-sm)] shrink-0" />
          <span className="truncate text-[length:var(--font-size-body)]">{chat.title || 'Untitled chat'}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}
