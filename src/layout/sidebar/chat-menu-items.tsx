/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { chatTitleLabel } from '@/lib/title-generator'
import { cn } from '@/lib/utils'
import type { ChatListProps } from './types'
import { useSidebarPreviewState } from './use-sidebar-preview-state'

/** A compact chat list shared by the project and Recents rail menus. */
export const ChatMenuItems = ({
  chatThreads,
  currentChatThreadId,
  onChatClick,
}: Pick<ChatListProps, 'chatThreads' | 'currentChatThreadId' | 'onChatClick'>) => {
  const { i18n } = useLingui()
  const preview = useSidebarPreviewState(chatThreads, currentChatThreadId)

  return (
    <>
      {preview.items.map((thread) => (
        <DropdownMenuItem
          key={thread.id}
          aria-current={thread.id === currentChatThreadId ? 'page' : undefined}
          className={cn('cursor-pointer', thread.id === currentChatThreadId && 'bg-accent font-medium')}
          onSelect={() => onChatClick(thread.id, thread.miniAppId)}
        >
          <span className="truncate">{chatTitleLabel(i18n, thread.title)}</span>
        </DropdownMenuItem>
      ))}
      {chatThreads.length === 0 && (
        <p className="px-2 py-3 text-sm text-muted-foreground">
          <Trans>No chats yet</Trans>
        </p>
      )}
      {preview.hasOverflow && (
        <DropdownMenuItem
          className="cursor-pointer text-[length:var(--font-size-sm)] text-muted-foreground"
          onSelect={(event) => {
            event.preventDefault()
            preview.toggle()
          }}
        >
          {preview.showAll ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
        </DropdownMenuItem>
      )}
    </>
  )
}
