/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

/**
 * Shared chats — server-only; what devices list syncs through the read-only
 * `received_shares` and `sent_shares` projections. A share is one frozen
 * snapshot of a chat, encrypted under a random share key the server never holds.
 * A chat has at most one share: sharing it again replaces the snapshot, the key
 * and the recipient list in place, keeping the id so earlier links still work.
 * Revoking a share or a recipient deletes rows outright: removing the ciphertext
 * is what revoking means.
 */
export const chatSharesTable = pgTable(
  'chat_shares',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Not a FK: chat_threads is a synced table owned by PowerSync. Every read
    // joins it instead, so a deleted chat stops being served at once.
    chatThreadId: text('chat_thread_id').notNull(),
    encryptedSnapshot: text('encrypted_snapshot').notNull(),
    encryptedTitle: text('encrypted_title').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** When the snapshot was last replaced — what recipients see as "shared". */
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    /** Bumped on every replace; a replace must name the version it read (`replacesVersion`). */
    version: integer('version').default(1).notNull(),
  },
  (table) => [uniqueIndex('chat_shares_owner_user_id_chat_thread_id_uidx').on(table.ownerUserId, table.chatThreadId)],
)

/** One recipient of a share: the share key sealed to their inbox key version. */
export const chatShareRecipientsTable = pgTable(
  'chat_share_recipients',
  {
    shareId: text('share_id')
      .notNull()
      .references(() => chatSharesTable.id, { onDelete: 'cascade' }),
    recipientUserId: text('recipient_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    inboxVersion: integer('inbox_version').notNull(),
    sealedShareKey: text('sealed_share_key').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shareId, table.recipientUserId] }),
    index('idx_chat_share_recipients_recipient_user_id').on(table.recipientUserId),
  ],
)

/**
 * When someone was last emailed that an owner shared a chat with them. Kept
 * apart from the recipient row, which removal deletes, so taking someone off a
 * share and adding them back — or stopping and sharing again — does not email
 * them each time.
 */
export const chatShareNotificationsTable = pgTable(
  'chat_share_notifications',
  {
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    recipientUserId: text('recipient_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatThreadId: text('chat_thread_id').notNull(),
    notifiedAt: timestamp('notified_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.chatThreadId, table.recipientUserId] }),
    index('idx_chat_share_notifications_recipient_user_id').on(table.recipientUserId),
  ],
)
