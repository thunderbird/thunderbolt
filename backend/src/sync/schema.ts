import { relations } from 'drizzle-orm'
import { bigint, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from '../db/auth-schema'

/**
 * Store change events per user for multi-device sync
 * This table acts as a relay for cr-sqlite changes between devices
 */
export const syncChanges = pgTable(
  'sync_changes',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    siteId: text('site_id').notNull(), // Device that made the change
    tableName: text('table_name').notNull(),
    pk: text('pk').notNull(), // Primary key (base64 encoded)
    cid: text('cid').notNull(), // Column ID
    val: text('val'), // Value (JSON stringified)
    colVersion: bigint('col_version', { mode: 'bigint' }).notNull(),
    dbVersion: bigint('db_version', { mode: 'bigint' }).notNull(),
    cl: integer('cl').notNull(), // Causal length
    seq: integer('seq').notNull(), // Sequence number
    siteIdRaw: text('site_id_raw').notNull(), // Site ID (base64 encoded)
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('sync_changes_user_id_idx').on(table.userId),
    index('sync_changes_user_site_idx').on(table.userId, table.siteId),
    index('sync_changes_created_at_idx').on(table.createdAt),
  ],
)

/**
 * Track the last sync version for each user's device
 */
export const syncDevices = pgTable(
  'sync_devices',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    siteId: text('site_id').notNull(), // Device site ID
    migrationVersion: text('migration_version'), // Last migration hash this device synced with
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('sync_devices_user_id_idx').on(table.userId), index('sync_devices_site_id_idx').on(table.siteId)],
)

export const syncChangesRelations = relations(syncChanges, ({ one }) => ({
  user: one(user, {
    fields: [syncChanges.userId],
    references: [user.id],
  }),
}))

export const syncDevicesRelations = relations(syncDevices, ({ one }) => ({
  user: one(user, {
    fields: [syncDevices.userId],
    references: [user.id],
  }),
}))
