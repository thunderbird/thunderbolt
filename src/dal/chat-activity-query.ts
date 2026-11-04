/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, desc, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'

/** UUIDv7 ids order activity without loading message bodies or writing extra timestamps. */
export const getChatActivityQuery = (db: AnyDrizzleDatabase, filter?: SQL) => {
  const lastActivityId = sql<string>`max(${chatThreadsTable.id}, coalesce(max(${chatMessagesTable.id}), ${chatThreadsTable.id}))`
  return db
    .select({ ...getTableColumns(chatThreadsTable), lastActivityId: lastActivityId.as('last_activity_id') })
    .from(chatThreadsTable)
    .leftJoin(
      chatMessagesTable,
      and(eq(chatMessagesTable.chatThreadId, chatThreadsTable.id), isNull(chatMessagesTable.deletedAt)),
    )
    .where(and(isNull(chatThreadsTable.deletedAt), filter))
    .groupBy(chatThreadsTable.id)
    .orderBy(desc(lastActivityId), desc(chatThreadsTable.id))
}
