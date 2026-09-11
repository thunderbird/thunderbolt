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

/** Deployments allowed to submit transcripts to the intake. Rows are revoked, never deleted. */
export const debugTranscriptClientsTable = pgTable('debug_transcript_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  keyHash: text('key_hash').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
})

/** Every transcript the intake accepted, from any client. `user_id` is an id in the client's own database. */
export const debugTranscriptsTable = pgTable(
  'debug_transcripts',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => debugTranscriptClientsTable.id, { onDelete: 'restrict' }),
    userId: text('user_id'),
    // local_user_id is set only for the intake host's own users (client self) so account deletion cascades;
    // external clients' users are not ours.
    localUserId: text('local_user_id').references(() => user.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payload: jsonb('payload').$type<DebugTranscriptPayload>().notNull(),
    userNote: text('user_note'),
    clientVersion: text('client_version'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('idx_debug_transcripts_client_id_created_at').on(table.clientId, table.createdAt)],
)
