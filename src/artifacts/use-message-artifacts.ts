/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, isNull, sql } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { renderHtmlToolName } from './constants'
import { messageArtifacts } from './library'

/** Select live artifact-bearing messages across projects, apps and execution environments. */
export const artifactMessagesQuery = (db: AnyDrizzleDatabase) =>
  db
    .select({
      id: chatMessagesTable.id,
      chatThreadId: chatMessagesTable.chatThreadId,
      parts: chatMessagesTable.parts,
      chatTitle: chatThreadsTable.title,
    })
    .from(chatMessagesTable)
    .innerJoin(chatThreadsTable, eq(chatThreadsTable.id, chatMessagesTable.chatThreadId))
    .where(
      and(
        isNull(chatThreadsTable.deletedAt),
        isNull(chatMessagesTable.deletedAt),
        sql`${chatMessagesTable.parts} LIKE ${`%${renderHtmlToolName}%`}`,
      ),
    )

/** Subscribe to local and synced chat artifacts, with no cloud-runtime dependency. */
export const useMessageArtifacts = () => {
  const db = useDatabase()
  const query = useQuery({ queryKey: ['artifact-messages'], query: toCompilableQuery(artifactMessagesQuery(db)) })
  return { ...query, artifacts: messageArtifacts(query.data ?? []) }
}
