/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MessageCirclePlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'

import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Floating "New Chat" action pinned to the bottom-right of every non-chat
 * screen (settings, tasks, dev tools), so starting a conversation is always
 * one tap away. Mobile-only: desktop gets the New Chat button in the sidebar
 * footer instead. Hidden on /chats routes, where the composer itself is the
 * primary affordance. Painted with the brand gradient (same sweep as the
 * switch ON track and the sync cloud).
 */
export const NewChatFab = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile } = useIsMobile()

  if (!isMobile || location.pathname.startsWith('/chats')) {
    return null
  }

  return (
    <button
      type="button"
      onClick={() => navigate('/chats/new')}
      className="fixed right-5 z-40 flex h-[var(--touch-height-default)] cursor-pointer items-center gap-2 rounded-full px-4 text-[length:var(--font-size-body)] font-medium text-brand-foreground shadow-lg transition-transform [background-image:var(--gradient-brand)] hover:scale-[1.03] active:scale-[0.98]"
      style={{ bottom: 'calc(1.25rem + var(--safe-area-bottom-padding, 0px))' }}
    >
      <MessageCirclePlus className="size-[var(--icon-size-default)]" aria-hidden="true" />
      New Chat
    </button>
  )
}
