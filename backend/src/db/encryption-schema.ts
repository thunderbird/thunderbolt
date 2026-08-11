/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { boolean, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
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
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('idx_envelopes_user_id').on(table.userId)],
)

/**
 * One row per user account. Stores the canary (encrypted under the primary DEK),
 * the KDF salt for recovery-seed → AK derivation, the ECDSA P-256 public key for
 * challenge-response verification, and the keyring pointers polled by clients
 * (`key_version` bumps on AK rotation; `primary_key_id` moves on DEK rotation).
 * `signing_public_key`/`kdf_salt` are nullable: pre-v2 rows have neither until
 * the beta reset re-runs setup.
 */
export const encryptionMetadataTable = pgTable('encryption_metadata', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  canaryIv: text('canary_iv').notNull(),
  canaryCtext: text('canary_ctext').notNull(),
  signingPublicKey: text('signing_public_key'),
  kdfSalt: text('kdf_salt'),
  keyVersion: integer('key_version').default(1).notNull(),
  primaryKeyId: text('primary_key_id').default('0').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Versioned DEK keyring — one row per (key_id, user_id). `wrapped_key` is the
 * DEK wrapped (AES-KW) under the user's current AK. The DEK material for a
 * key_id is immutable; its AK-wrapping is mutable and MUST be rewritten for
 * EVERY key_id on each AK rotation (see A1/A5 in the implementation plan).
 */
export const wrappedKeysTable = pgTable(
  'wrapped_keys',
  {
    keyId: text('key_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    wrappedKey: text('wrapped_key').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.keyId, table.userId] }), index('idx_wrapped_keys_user_id').on(table.userId)],
)

/**
 * Single-use challenge nonces for ECDSA proof-of-key-possession (replaces the
 * static canary secret). A nonce is bound to (user, operation, device) and is
 * consumed exactly once before expiry. Swept periodically (A7).
 */
export const challengeNoncesTable = pgTable(
  'challenge_nonces',
  {
    nonce: text('nonce').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    deviceId: text('device_id').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumed: boolean('consumed').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('idx_challenge_nonces_user_id').on(table.userId)],
)
