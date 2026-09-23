/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trackEvent } from '@/lib/posthog'
import { useCallback } from 'react'
import { useNavigate } from 'react-router'

/**
 * Shared core for starting a new chat: tracks the event and navigates to
 * `/chats/new`. Callers layer their own side effects (e.g. closing the
 * mobile sidebar) around this — it deliberately owns only the shared core.
 *
 * The navigation carries `focusComposer`, a consume-once request the chat
 * composer honors on arrival (see `chat-prompt-input.tsx`) so the tap lands
 * ready to type — keyboard up on the native mobile apps. The composer's
 * mount-time `autoFocus` can't cover this on its own: starting a chat from
 * `/chats/new` reuses the same composer instance, so nothing remounts.
 */
export const useCreateNewChat = () => {
  const navigate = useNavigate()

  return useCallback(() => {
    trackEvent('chat_new_clicked')
    navigate('/chats/new', { state: { focusComposer: true } })
  }, [navigate])
}
