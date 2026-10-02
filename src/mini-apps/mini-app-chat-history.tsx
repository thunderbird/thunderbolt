/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Past chats started from this app, and the way to start another — one control.
 *
 * A menu rather than a panel or a sidebar section: the app owns the canvas, and
 * its own chats are a small, occasional list, so surfacing them permanently
 * would take space from the thing the user came for. They also stay in the
 * ordinary chat sidebar, so this is a shortcut rather than the only route.
 *
 * "New chat" lives inside it rather than beside it (THU-904). Two adjacent
 * icon buttons in a narrow panel header is a lot of chrome for one occasional
 * job, and the pair read as unrelated when they are the same job: pick a
 * conversation, or start one. It sits at the *top* because starting a new chat
 * is the commoner intent and a long history would otherwise push it off screen.
 */

import { Trans, useLingui } from '@lingui/react/macro'
import { History, MessageCirclePlus } from 'lucide-react'

import { Button, mutedIconButtonClass } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'

type MiniAppChatHistoryProps = {
  chats: readonly MiniAppChat[]
  /** Reopen one beside the app. */
  onOpenChat: (chatThreadId: string) => void
  /** Put a blank conversation in the panel, leaving the current one alone. */
  onNewChat: () => void
}

export const MiniAppChatHistory = ({ chats, onOpenChat, onNewChat }: MiniAppChatHistoryProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          /*
           * A circle at every width. `mutedIconButtonClass` is `rounded-full`
           * on mobile but `md:rounded-xl` on desktop, and the rounded square is
           * the aside shape — this is a sidebar, and it sits next to the round
           * close button in the same header.
           */
          className={cn(mutedIconButtonClass, 'rounded-full md:rounded-full')}
          aria-label={t`Chats from this app`}
        >
          <History />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(24rem,60vh)] w-72">
        {/* Styled as a row rather than a menu item so it reads as an action on
            the list, matching the "New Skill" row in the skills popover. */}
        <DropdownMenuItem
          onSelect={onNewChat}
          className="shrink-0 cursor-pointer gap-2 font-medium text-muted-foreground focus:text-foreground"
        >
          <MessageCirclePlus className="size-[var(--icon-size-sm)]" />
          <Trans>New chat</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* The settings-list section-label treatment, so it reads as a heading
            over the rows rather than as a row itself. */}
        <DropdownMenuLabel className="shrink-0 text-[length:var(--font-size-xs)] uppercase tracking-wide text-muted-foreground">
          <Trans>Chats from this app</Trans>
        </DropdownMenuLabel>
        {/* The list is the only region that scrolls, so "New chat" stays put
            however many conversations this app has accumulated. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {chats.length === 0 ? (
            <div className="px-2 py-3 text-[length:var(--font-size-sm)] text-muted-foreground">
              <Trans>No chats yet. Anything you ask beside this app shows up here.</Trans>
            </div>
          ) : (
            chats.map((chat) => (
              <DropdownMenuItem
                key={chat.id}
                onSelect={() => onOpenChat(chat.id)}
                // `cursor-pointer` because the primitive ships shadcn's
                // `cursor-default`, and every other menu in the app overrides it
                // at the call site. Matching the convention rather than changing
                // the primitive: that would silently restyle every menu we have.
                className="flex cursor-pointer flex-col items-start"
              >
                <span className="w-full truncate">{chat.title ?? t`Untitled chat`}</span>
                <span className="text-[length:var(--font-size-xs)] text-muted-foreground">
                  {formatters.relativeTime(chat.lastActivityAt)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
