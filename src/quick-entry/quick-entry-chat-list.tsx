/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SearchableMenu, type SearchableMenuGroup } from '@/components/ui/searchable-menu'
import { useLingui } from '@lingui/react/macro'
import { MessageCircle, Plus } from 'lucide-react'
import type { QuickEntryChat } from './events'

/** Menu id of the "New Chat" row; chat ids are UUIDs, so it cannot collide. */
const newChatId = 'new'

type QuickEntryChatListProps = {
  chats: QuickEntryChat[]
  /** null is a new chat. */
  selectedChatId: string | null
  onSelect: (chatId: string | null) => void
  onClose: () => void
}

/** The chat picker's list: "New Chat", then recent chats, in the model picker's inline style. */
export const QuickEntryChatList = ({ chats, selectedChatId, onSelect, onClose }: QuickEntryChatListProps) => {
  const { t } = useLingui()

  const groups: SearchableMenuGroup[] = [
    {
      id: 'new',
      items: [{ id: newChatId, label: t`New Chat`, icon: <Plus className="size-4 text-muted-foreground" /> }],
    },
    ...(chats.length > 0
      ? [
          {
            id: 'recents',
            label: t`Recents`,
            items: chats.map((chat) => ({
              id: chat.id,
              label: chat.title,
              icon: <MessageCircle className="size-4 text-muted-foreground" />,
            })),
          },
        ]
      : []),
  ]

  return (
    <>
      <div className="flex shrink-0 items-center pl-3 pr-4 pt-2 pb-1">
        <span className="text-[length:var(--font-size-xs)] font-medium text-muted-foreground">{t`Chat`}</span>
      </div>
      <SearchableMenu
        embedded
        items={groups}
        value={selectedChatId ?? newChatId}
        onValueChange={(id) => onSelect(id === newChatId ? null : id)}
        onOpenChange={(open) => {
          if (!open) {
            onClose()
          }
        }}
        searchable={chats.length > 10}
        maxHeight={220}
      />
    </>
  )
}
