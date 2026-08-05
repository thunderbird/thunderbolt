/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { deleteAllChatThreads } from '@/dal'
import { trackEvent } from '@/lib/posthog'
import { useCallback } from 'react'
import { useNavigate } from 'react-router'

/**
 * Shared core for clearing all chat threads: deletes every thread, tracks
 * the event, then navigates to `/chats/new`. Callers own confirmation and
 * dialog-close behavior — this deliberately owns only the shared core.
 */
export const useDeleteAllChats = () => {
  const db = useDatabase()
  const navigate = useNavigate()

  return useCallback(async () => {
    await deleteAllChatThreads(db)
    trackEvent('chat_clear_all')
    navigate('/chats/new')
  }, [db, navigate])
}
