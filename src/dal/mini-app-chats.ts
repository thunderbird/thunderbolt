/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Chats that were started from a Mini App. */

import { eq } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { chatThreadsTable } from '@/db/tables'
import { uuidv7ToDate } from '@/lib/utils'
import { getChatActivityQuery } from './chat-activity-query'

/** A chat started from a Mini App, with when it was last active. */
export type MiniAppChat = { id: string; title: string | null; lastActivityAt: Date }

/** Live chats started from one Mini App, in the sidebar's activity order. */
export const useMiniAppChats = (appId: string): MiniAppChat[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['miniAppChats', appId],
    query: toCompilableQuery(getChatActivityQuery(db, eq(chatThreadsTable.miniAppId, appId))),
  })
  return data.map((row) => ({
    id: row.id,
    title: row.title,
    lastActivityAt: uuidv7ToDate(row.lastActivityId),
  }))
}
