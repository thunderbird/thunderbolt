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
 */
export const useCreateNewChat = () => {
  const navigate = useNavigate()

  return useCallback(() => {
    trackEvent('chat_new_clicked')
    navigate('/chats/new')
  }, [navigate])
}
