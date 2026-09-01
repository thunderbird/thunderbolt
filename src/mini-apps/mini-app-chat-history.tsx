/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Past chats started from this app, reachable from its header.
 *
 * A menu rather than a panel or a sidebar section: the app owns the canvas, and
 * its own chats are a small, occasional list — surfacing them permanently would
 * take space from the thing the user came for. They also stay in the ordinary
 * chat sidebar, so this is a shortcut, not the only route to them.
 */

import { Trans, useLingui } from '@lingui/react/macro'
import { History } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { MiniAppChat } from '@/dal/mini-app-chats'
import { useFormatters } from '@/i18n/use-formatters'

type MiniAppChatHistoryProps = {
  chats: readonly MiniAppChat[]
  /** Reopen one beside the app. */
  onOpenChat: (chatThreadId: string) => void
}

export const MiniAppChatHistory = ({ chats, onOpenChat }: MiniAppChatHistoryProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t`Chats from this app`}>
          <History className="size-[var(--icon-size-default)]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>
          <Trans>Chats from this app</Trans>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {chats.length === 0 ? (
          <div className="px-2 py-3 text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>No chats yet. Anything you ask beside this app shows up here.</Trans>
          </div>
        ) : (
          chats.map((chat) => (
            <DropdownMenuItem key={chat.id} onSelect={() => onOpenChat(chat.id)} className="flex flex-col items-start">
              <span className="truncate w-full">{chat.title ?? 'Untitled chat'}</span>
              <span className="text-[length:var(--font-size-xs)] text-muted-foreground">
                {formatters.relativeTime(chat.lastActivityAt)}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
