/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Chats that were started from a Mini App.
 *
 * Deliberately separate from `projects.ts` despite the near-identical query.
 * A project is a row this app owns and can clean up after; a Mini App is
 * deployment config that can vanish between releases, so the two disagree
 * about what happens when the parent goes away — projects orphan their chats
 * on delete, apps leave theirs pointing at an id that no longer resolves.
 * Sharing the query would invite sharing that lifecycle too.
 */

import { and, eq, isNull, sql } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { chatMessagesTable, chatThreadsTable } from '../db/tables'
import { uuidv7ToDate } from '../lib/utils'

export type MiniAppChat = {
  id: string
  title: string | null
  lastActivityAt: Date
}

/**
 * Live chats started from one Mini App, newest activity first.
 *
 * `MAX(id)` over UUIDv7 message ids doubles as the last-activity time —
 * `chat_messages` has no timestamp column. Same trick as `useProjectChats`.
 */
export const useMiniAppChats = (appId: string): MiniAppChat[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['miniAppChats', appId],
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
        .where(and(eq(chatThreadsTable.miniAppId, appId), isNull(chatThreadsTable.deletedAt)))
        .groupBy(chatThreadsTable.id, chatThreadsTable.title),
    ),
  })
  return (data as { id: string; title: string | null; lastMessageId: string | null }[])
    .map((row) => ({
      id: row.id,
      title: row.title,
      lastActivityAt: uuidv7ToDate(row.lastMessageId ?? row.id),
    }))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
}
