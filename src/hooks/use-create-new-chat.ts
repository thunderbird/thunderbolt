/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trackEvent } from '@/lib/posthog'
import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

/**
 * Shared core for starting a new chat: tracks the event and navigates to
 * `/chats/new`. Callers layer their own side effects (e.g. closing the
 * mobile sidebar) around this — it deliberately owns only the shared core.
 *
 * The navigation carries `focusComposer`, a consume-once request the chat
 * composer honors on arrival (see `chat-prompt-input.tsx`) so the tap lands
 * ready to type — keyboard up on the native mobile apps. The explicit draft
 * request also makes repeated New Chat actions distinct, even when
 * the URL stays `/chats/new`.
 */
export const useCreateNewChat = () => {
  const navigate = useNavigate()

  return useCallback(
    (projectId?: string) => {
      trackEvent('chat_new_clicked')
      const search = projectId ? `?${new URLSearchParams({ projectId })}` : ''
      navigate(`/chats/new${search}`, { state: { focusComposer: true, newChatRequestId: uuidv7() } })
    },
    [navigate],
  )
}
