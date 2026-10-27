/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Live chats under one owner, newest activity first.
 *
 * Projects and Mini Apps each had their own copy of this query — the same
 * select, the same join, the same `MAX(id)` trick, the same map and sort,
 * differing only in which column they filtered on. The Mini App copy justified
 * the fork on the two features' *delete* lifecycles being different, which is
 * true and lives entirely in their mutations; a read query encodes none of it.
 *
 * What the duplication actually put at risk is right here: the `MAX(id)`
 * stand-in for a timestamp, and the absence of a `LIMIT`. Fixing either meant
 * finding both copies.
 */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import type { SQL } from 'drizzle-orm'

import { useDatabase } from '@/contexts'
import { uuidv7ToDate } from '@/lib/utils'
import { getChatActivityQuery } from './chat-activity-query'

export type ChatWithLastActivity = {
  id: string
  title: string | null
  lastActivityAt: Date
}

/**
 * @param queryKey - cache key for this owner, e.g. `['miniAppChats', appId]`
 * @param owner - which column ties a chat to its owner, e.g. `eq(chatThreadsTable.miniAppId, appId)`
 *
 * Shares activity ordering with the sidebar and project folders. Only the
 * displayed date needs conversion from the UUIDv7 activity id.
 */
export const useChatsWithLastActivity = (queryKey: readonly unknown[], owner: SQL): ChatWithLastActivity[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: [...queryKey],
    query: toCompilableQuery(getChatActivityQuery(db, owner)),
  })

  return data.map((row) => ({
    id: row.id,
    title: row.title,
    lastActivityAt: uuidv7ToDate(row.lastActivityId),
  }))
}
