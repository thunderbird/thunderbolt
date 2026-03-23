import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'
import { devicesTable } from './powersync-schema'

/**
 * Encryption tables — server-side only, never synced via PowerSync.
 * These tables store wrapped keys and canary data for E2E encryption.
 */

/** One row per trusted device. Each device fetches only its own row via API. */
export const envelopesTable = pgTable(
  'envelopes',
  {
    deviceId: text('device_id')
      .primaryKey()
      .references(() => devicesTable.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    wrappedCk: text('wrapped_ck').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('idx_envelopes_user_id').on(table.userId)],
)

/** One row per user account. Stores canary for recovery key verification. */
export const encryptionMetadataTable = pgTable('encryption_metadata', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  canaryIv: text('canary_iv').notNull(),
  canaryCtext: text('canary_ctext').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
