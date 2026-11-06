/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, desc, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'

/**
 * A chat's latest activity id, correlated to the enclosing `chat_threads` row.
 * A correlated lookup uses PowerSync's message index instead of rescanning its JSON view per chat.
 */
export const getChatLastActivityId = (db: AnyDrizzleDatabase) => {
  const latestMessage = db
    .select({ id: sql<string>`max(${chatMessagesTable.id})` })
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.chatThreadId, chatThreadsTable.id), isNull(chatMessagesTable.deletedAt)))
  return sql<string>`max(${chatThreadsTable.id}, coalesce((${latestMessage}), ${chatThreadsTable.id}))`
}

/** UUIDv7 ids order activity without loading message bodies or writing extra timestamps. */
export const getChatActivityQuery = (db: AnyDrizzleDatabase, filter?: SQL) => {
  const lastActivityId = getChatLastActivityId(db)
  return db
    .select({ ...getTableColumns(chatThreadsTable), lastActivityId: lastActivityId.as('last_activity_id') })
    .from(chatThreadsTable)
    .where(and(isNull(chatThreadsTable.deletedAt), filter))
    .orderBy(({ lastActivityId }) => [desc(lastActivityId), desc(chatThreadsTable.id)])
}
