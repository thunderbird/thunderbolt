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
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'

import { useDatabase } from '@/contexts'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { uuidv7ToDate } from '@/lib/utils'

export type ChatWithLastActivity = {
  id: string
  title: string | null
  lastActivityAt: Date
}

type ChatsWithLastActivityRow = { id: string; title: string | null; lastMessageId: string | null }

/**
 * @param queryKey - cache key for this owner, e.g. `['miniAppChats', appId]`
 * @param owner - which column ties a chat to its owner, e.g. `eq(chatThreadsTable.miniAppId, appId)`
 *
 * `MAX(id)` over UUIDv7 message ids is both the newest message and when it
 * happened — `chat_messages` has no timestamp column. Sorting happens in JS
 * because the value is derived after the query, and ties break on id so two
 * chats whose newest messages land in the same millisecond hold a stable order
 * between renders rather than swapping places.
 */
export const useChatsWithLastActivity = (queryKey: readonly unknown[], owner: SQL): ChatWithLastActivity[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: [...queryKey],
    query: toCompilableQuery(
      db
        .select({
          id: chatThreadsTable.id,
          title: chatThreadsTable.title,
          lastMessageId: sql<string | null>`max(${chatMessagesTable.id})`.as('last_message_id'),
        })
        .from(chatThreadsTable)
        .leftJoin(
          chatMessagesTable,
          and(eq(chatMessagesTable.chatThreadId, chatThreadsTable.id), isNull(chatMessagesTable.deletedAt)),
        )
        .where(and(owner, isNull(chatThreadsTable.deletedAt)))
        .groupBy(chatThreadsTable.id, chatThreadsTable.title),
    ),
  })

  return (data as ChatsWithLastActivityRow[])
    .map((row) => ({
      id: row.id,
      title: row.title,
      lastActivityAt: uuidv7ToDate(row.lastMessageId ?? row.id),
    }))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || a.id.localeCompare(b.id))
}
