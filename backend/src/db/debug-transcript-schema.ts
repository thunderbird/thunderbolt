/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

export type DebugTranscriptJsonValue =
  | string
  | number
  | boolean
  | null
  | DebugTranscriptJsonValue[]
  | { [key: string]: DebugTranscriptJsonValue }

export type DebugTranscriptPayload = {
  [key: string]: DebugTranscriptJsonValue
}

/** Server-only plaintext transcripts retained until their owning account is deleted. */
export const debugTranscriptsTable = pgTable(
  'debug_transcripts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payload: jsonb('payload').$type<DebugTranscriptPayload>().notNull(),
    userNote: text('user_note'),
    clientVersion: text('client_version'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('idx_debug_transcripts_user_id_created_at').on(table.userId, table.createdAt)],
)
