/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { boolean, index, integer, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'
import { devicesTable } from './powersync-schema'

/**
 * Encryption tables — server-side only, never synced via PowerSync.
 * These tables store wrapped keys, the canary, and challenge nonces for E2E
 * encryption. Because they are not synced, adding/altering them is a plain
 * Drizzle migration (no `shared/powersync-tables.ts` change, no sync-rule edit,
 * no PowerSync two-PR flow — see plan §6.4).
 */

/**
 * One row per trusted device. Each device fetches only its own row via API.
 * `wrapped_ck` now carries the wrapped AK (v1 naming debt retained to avoid wire
 * churn — documented, not renamed; see plan Risk 12).
 */
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
 * One row per user account. Stores the canary (v1: encrypted under CK; v2:
 * re-encrypted under the primary DEK), the KDF salt for recovery-seed →
 * recovery-keypair derivation, the ECDSA P-256 public key for challenge-response
 * verification, the recovery slot (see below), and the keyring pointers polled
 * by clients (`key_version` bumps on AK rotation; `primary_key_id` moves on DEK
 * rotation; `scheme_version` flips 1→2 on migration).
 *
 * The recovery phrase is a VIRTUAL DEVICE: the seed deterministically derives a
 * hybrid keypair whose PUBLIC halves live in `recovery_ecdh_public_key` /
 * `recovery_mlkem_public_key`, and `recovery_wrapped_ak` is the AK wrapped to
 * them exactly like a device envelope. That is what lets any trusted device
 * rotate the AK (wrapping needs only public keys) without invalidating the
 * user's phrase. All three are nullable: a pre-flip (scheme 1) account has none
 * of them until it upgrades.
 *
 * `canary_secret_hash` is RETAINED (Decision B): it is the v1 CK-possession
 * anchor consumed by `/upgrade` — the migrator CK-decrypts `canary_ctext` to
 * recover `canarySecret` and the server verifies `hash(canarySecret)` against
 * this column before accepting the new AK. `signing_public_key`/`kdf_salt` are
 * nullable for the same pre-flip reason.
 */
export const encryptionMetadataTable = pgTable('encryption_metadata', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  canaryIv: text('canary_iv').notNull(),
  canaryCtext: text('canary_ctext').notNull(),
  canarySecretHash: text('canary_secret_hash'),
  signingPublicKey: text('signing_public_key'),
  kdfSalt: text('kdf_salt'),
  recoveryEcdhPublicKey: text('recovery_ecdh_public_key'),
  recoveryMlkemPublicKey: text('recovery_mlkem_public_key'),
  recoveryWrappedAk: text('recovery_wrapped_ak'),
  keyVersion: integer('key_version').default(1).notNull(),
  primaryKeyId: text('primary_key_id').default('0').notNull(),
  schemeVersion: smallint('scheme_version').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Versioned DEK keyring — one row per (key_id, user_id). `wrapped_key` is the
 * DEK wrapped (AES-KW) under the user's current AK. The DEK material for a
 * key_id is immutable; its AK-wrapping is mutable and MUST be rewritten for
 * EVERY key_id on each AK rotation (plan §2.4, Track A). Rows are retained,
 * never deleted — including the reserved `"v1"` absorbed-CK slot.
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
 * Org-escrow envelopes (THU-804 POC) — one row per user, the AK wrapped to the
 * operator-supplied P-256 escrow public key. The server only ever holds the
 * public half, so it cannot unwrap what it stores; recovery is a standalone
 * offline tool run by the operator holding the private key. Upserted inside the
 * same transaction as setup/rotate/upgrade whenever escrow is enabled.
 */
export const orgEnvelopesTable = pgTable('org_envelopes', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  wrappedAk: text('wrapped_ak').notNull(),
  keyFingerprint: text('key_fingerprint').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

/**
 * Single-use challenge nonces for ECDSA proof-of-key-possession (replaces the
 * v1 static canary secret). A nonce is bound to (user, operation, device) and
 * is consumed exactly once before expiry. Swept periodically (plan Track A A7).
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
