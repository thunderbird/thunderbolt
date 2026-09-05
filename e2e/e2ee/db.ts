/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Postgres helpers for the PowerSync E2EE suite. Talks directly to the same
 * Postgres the backend + PowerSync service use (booted by
 * scripts/run-e2ee-powersync.sh) to (a) poll for server-side state and (b) seed
 * a REAL legacy v1 account for the data-preserving v1→v2 migration test.
 */

import postgres from 'postgres'

const postgresPort = process.env.E2E_POSTGRES_PORT ?? '5434'
/**
 * Shared connection. Exported so `oracles.ts` can query the server's view of the
 * data without opening a second pool (`max: 1`, so a second one would contend).
 */
export const sql = postgres(`postgresql://postgres:postgres@localhost:${postgresPort}/postgres`, {
  max: 1,
  onnotice: () => {},
})

const poll = async <T>(load: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await load()
    if (value !== null) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Database condition was not met within ${timeoutMs}ms`)
}

export const closeE2eeDb = async (): Promise<void> => {
  await sql.end()
}

// =============================================================================
// Auth / identity
// =============================================================================

export const waitForOtp = async (email: string, previousValue: string | null = null): Promise<string> =>
  poll(async () => {
    const rows = await sql<{ value: string }[]>`
      SELECT value
      FROM verification
      WHERE identifier = ${`sign-in-otp-${email}`}
      ORDER BY updated_at DESC
      LIMIT 1
    `
    const value = rows[0]?.value
    return value && value !== previousValue ? value : null
  })

export const getCurrentOtp = async (email: string): Promise<string | null> => {
  const rows = await sql<{ value: string }[]>`
    SELECT value
    FROM verification
    WHERE identifier = ${`sign-in-otp-${email}`}
    LIMIT 1
  `
  return rows[0]?.value ?? null
}

export const waitForUserId = async (email: string): Promise<string> =>
  poll(async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM "user" WHERE email = ${email} LIMIT 1
    `
    return rows[0]?.id ?? null
  })

// =============================================================================
// Encryption server state
// =============================================================================

export type FirstDeviceServerState = {
  keyVersion: number
  primaryKeyId: string
  wrappedKeyIds: string[]
  trustedDeviceCount: number
  envelopeCount: number
  /** All three recovery-slot columns populated — bootstrap must write the phrase's virtual-device envelope. */
  hasRecoverySlot: boolean
}

export const waitForFirstDeviceState = async (userId: string): Promise<FirstDeviceServerState> =>
  poll(async () => {
    const metadata = await sql<
      {
        key_version: number
        primary_key_id: string
        recovery_ecdh_public_key: string | null
        recovery_mlkem_public_key: string | null
        recovery_wrapped_ak: string | null
      }[]
    >`
      SELECT key_version, primary_key_id, recovery_ecdh_public_key, recovery_mlkem_public_key, recovery_wrapped_ak
      FROM encryption_metadata
      WHERE user_id = ${userId}
    `
    const wrappedKeys = await sql<{ key_id: string }[]>`
      SELECT key_id FROM wrapped_keys WHERE user_id = ${userId} ORDER BY key_id
    `
    const devices = await sql<{ trusted_device_count: number; envelope_count: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE d.trusted AND d.revoked_at IS NULL)::int AS trusted_device_count,
        COUNT(e.device_id)::int AS envelope_count
      FROM powersync.devices d
      LEFT JOIN envelopes e ON e.device_id = d.id
      WHERE d.user_id = ${userId}
    `
    const metadataRow = metadata[0]
    const deviceRow = devices[0]
    if (!metadataRow || wrappedKeys.length === 0 || !deviceRow?.trusted_device_count || !deviceRow.envelope_count) {
      return null
    }
    return {
      keyVersion: metadataRow.key_version,
      primaryKeyId: metadataRow.primary_key_id,
      wrappedKeyIds: wrappedKeys.map((row) => row.key_id),
      trustedDeviceCount: deviceRow.trusted_device_count,
      envelopeCount: deviceRow.envelope_count,
      hasRecoverySlot:
        !!metadataRow.recovery_ecdh_public_key &&
        !!metadataRow.recovery_mlkem_public_key &&
        !!metadataRow.recovery_wrapped_ak,
    }
  })

export type EncryptionServerSnapshot = {
  keyVersion: number
  primaryKeyId: string
  schemeVersion: number
  wrappedKeys: Record<string, string>
  envelopes: Record<string, string>
  /**
   * The recovery slot — the phrase-as-virtual-device envelope. The two public
   * keys are derived from the seed, so they change ONLY when the user mints a
   * new phrase; `recoveryWrappedAk` changes on every AK rotation. That pair of
   * facts is what distinguishes a silent re-anchor (revoke) from a phrase change.
   */
  recoveryEcdhPublicKey: string | null
  recoveryMlkemPublicKey: string | null
  recoveryWrappedAk: string | null
}

type EncryptionMetadataRow = {
  key_version: number
  primary_key_id: string
  scheme_version: number
  recovery_ecdh_public_key: string | null
  recovery_mlkem_public_key: string | null
  recovery_wrapped_ak: string | null
}

export const getEncryptionServerSnapshot = async (userId: string): Promise<EncryptionServerSnapshot> => {
  const metadata = await sql<EncryptionMetadataRow[]>`
    SELECT
      key_version,
      primary_key_id,
      scheme_version,
      recovery_ecdh_public_key,
      recovery_mlkem_public_key,
      recovery_wrapped_ak
    FROM encryption_metadata WHERE user_id = ${userId}
  `
  const wrappedKeys = await sql<{ key_id: string; wrapped_key: string }[]>`
    SELECT key_id, wrapped_key FROM wrapped_keys WHERE user_id = ${userId} ORDER BY key_id
  `
  const envelopes = await sql<{ device_id: string; wrapped_ck: string }[]>`
    SELECT device_id, wrapped_ck FROM envelopes WHERE user_id = ${userId} ORDER BY device_id
  `
  const metadataRow = metadata[0]
  if (!metadataRow) {
    throw new Error(`Encryption metadata not found for ${userId}`)
  }
  return {
    keyVersion: metadataRow.key_version,
    primaryKeyId: metadataRow.primary_key_id,
    schemeVersion: metadataRow.scheme_version,
    wrappedKeys: Object.fromEntries(wrappedKeys.map((row) => [row.key_id, row.wrapped_key])),
    envelopes: Object.fromEntries(envelopes.map((row) => [row.device_id, row.wrapped_ck])),
    recoveryEcdhPublicKey: metadataRow.recovery_ecdh_public_key,
    recoveryMlkemPublicKey: metadataRow.recovery_mlkem_public_key,
    recoveryWrappedAk: metadataRow.recovery_wrapped_ak,
  }
}

/** The account's KDF salt — needed to reproduce the phrase-derived recovery keypair. */
export const getKdfSalt = async (userId: string): Promise<string> => {
  const rows = await sql<{ kdf_salt: string | null }[]>`
    SELECT kdf_salt FROM encryption_metadata WHERE user_id = ${userId}
  `
  const salt = rows[0]?.kdf_salt
  if (!salt) {
    throw new Error(`No kdf_salt for ${userId}`)
  }
  return salt
}

export const getSchemeVersion = async (userId: string): Promise<number | null> => {
  const rows = await sql<{ scheme_version: number }[]>`
    SELECT scheme_version FROM encryption_metadata WHERE user_id = ${userId}
  `
  return rows[0]?.scheme_version ?? null
}

/** Block until the account has flipped to scheme v2 and its keyring covers `expectedKeyIds`. */
export const waitForSchemeV2 = async (userId: string, expectedKeyIds: readonly string[]): Promise<void> => {
  await poll(async () => {
    const snapshot = await getEncryptionServerSnapshot(userId).catch(() => null)
    if (!snapshot || snapshot.schemeVersion !== 2) {
      return null
    }
    const keyIds = Object.keys(snapshot.wrappedKeys).sort()
    return [...expectedKeyIds].sort().every((id) => keyIds.includes(id)) ? true : null
    // Concurrent migrators reload and race their app-init flip; allow headroom for
    // the winner's CAS upgrade to land on a loaded CI runner.
  }, 150_000)
}

export type OrgEnvelopeRow = {
  wrappedAk: string
  keyFingerprint: string
}

/** Block until the org-escrow envelope row exists for the user (THU-804). */
export const waitForOrgEnvelope = async (userId: string): Promise<OrgEnvelopeRow> =>
  poll(async () => {
    const rows = await sql<{ wrapped_ak: string; key_fingerprint: string }[]>`
      SELECT wrapped_ak, key_fingerprint FROM org_envelopes WHERE user_id = ${userId}
    `
    const row = rows[0]
    return row ? { wrappedAk: row.wrapped_ak, keyFingerprint: row.key_fingerprint } : null
  }, 30_000)

export const waitForConsumedChallenge = async (userId: string, operation: string): Promise<void> => {
  await poll(async () => {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM challenge_nonces
      WHERE user_id = ${userId} AND operation = ${operation} AND consumed = true
    `
    return (rows[0]?.count ?? 0) > 0 ? true : null
  })
}

// =============================================================================
// Devices
// =============================================================================

export type DeviceServerState = {
  id: string
  trusted: boolean
  approvalPending: boolean
  revokedAt: Date | null
  hasEnvelope: boolean
}

export const waitForDeviceState = async (
  userId: string,
  deviceId: string,
  matches: (state: DeviceServerState) => boolean,
): Promise<DeviceServerState> =>
  poll(async () => {
    const rows = await sql<
      {
        id: string
        trusted: boolean
        approval_pending: boolean
        revoked_at: Date | null
        has_envelope: boolean
      }[]
    >`
      SELECT
        d.id,
        d.trusted,
        d.approval_pending,
        d.revoked_at,
        (e.device_id IS NOT NULL) AS has_envelope
      FROM powersync.devices d
      LEFT JOIN envelopes e ON e.device_id = d.id
      WHERE d.user_id = ${userId} AND d.id = ${deviceId}
    `
    const row = rows[0]
    if (!row) {
      return null
    }
    const state = {
      id: row.id,
      trusted: row.trusted,
      approvalPending: row.approval_pending,
      revokedAt: row.revoked_at,
      hasEnvelope: row.has_envelope,
    }
    return matches(state) ? state : null
  }, 30_000)

export type DeviceKeys = {
  deviceId: string
  publicKey: string
  mlkemPublicKey: string
}

/**
 * Wait until `count` of the user's devices have registered their transport
 * public keys (ECDH + ML-KEM), then return them. The v1-account seed wraps the
 * legacy CK for these exact public keys, so the real device (holding the
 * matching private keys in IndexedDB) can unwrap it during migration.
 */
export const waitForDeviceKeys = async (userId: string, count = 1): Promise<DeviceKeys[]> =>
  poll(async () => {
    const rows = await sql<{ id: string; public_key: string; mlkem_public_key: string }[]>`
      SELECT id, public_key, mlkem_public_key
      FROM powersync.devices
      WHERE user_id = ${userId} AND public_key IS NOT NULL AND mlkem_public_key IS NOT NULL
      ORDER BY created_at
    `
    if (rows.length < count) {
      return null
    }
    return rows.map((row) => ({ deviceId: row.id, publicKey: row.public_key, mlkemPublicKey: row.mlkem_public_key }))
  }, 30_000)

// =============================================================================
// v1 account seeding (data-preserving migration test)
// =============================================================================

export type SeedV1MetadataInput = {
  canaryIv: string
  canaryCtext: string
  canarySecretHash: string
}

/** Insert a legacy (scheme_version=1) encryption_metadata row — the pre-migration state. */
export const seedV1Metadata = async (userId: string, input: SeedV1MetadataInput): Promise<void> => {
  await sql`
    INSERT INTO encryption_metadata (user_id, canary_iv, canary_ctext, canary_secret_hash, scheme_version)
    VALUES (${userId}, ${input.canaryIv}, ${input.canaryCtext}, ${input.canarySecretHash}, 1)
  `
}

/** Insert the legacy device envelope carrying the hybrid-wrapped CK for a trusted device. */
export const seedV1Envelope = async (userId: string, deviceId: string, wrappedCk: string): Promise<void> => {
  await sql`
    INSERT INTO envelopes (device_id, user_id, wrapped_ck)
    VALUES (${deviceId}, ${userId}, ${wrappedCk})
  `
}

/** Mark a device trusted (the migrator must be trusted, or /upgrade returns 403). */
export const trustDevice = async (deviceId: string): Promise<void> => {
  await sql`
    UPDATE powersync.devices SET trusted = true, approval_pending = false WHERE id = ${deviceId}
  `
}

/** Seed a legacy v1-encrypted task row (item = __enc:<iv>:<ct>, no AAD). */
export const seedV1Task = async (userId: string, id: string, item: string): Promise<void> => {
  await sql`INSERT INTO powersync.tasks (id, user_id, item) VALUES (${id}, ${userId}, ${item})`
}

/** Seed a legacy v1-encrypted settings row (value = __enc:<iv>:<ct>, no AAD). */
export const seedV1Setting = async (userId: string, key: string, value: string): Promise<void> => {
  await sql`INSERT INTO powersync.settings (id, user_id, value) VALUES (${key}, ${userId}, ${value})`
}

/** Seed a legacy v1-encrypted chat thread row (title = __enc:<iv>:<ct>, no AAD). */
export const seedV1ChatThread = async (userId: string, id: string, title: string): Promise<void> => {
  await sql`INSERT INTO powersync.chat_threads (id, user_id, title) VALUES (${id}, ${userId}, ${title})`
}

// =============================================================================
// Tasks / settings (assertions)
// =============================================================================

export const getTaskIds = async (userId: string): Promise<Set<string>> => {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM powersync.tasks WHERE user_id = ${userId}
  `
  return new Set(rows.map((row) => row.id))
}

export type EncryptedTaskRow = {
  id: string
  item: string
}

export const getTaskCiphertext = async (taskId: string): Promise<string> => {
  const rows = await sql<{ item: string }[]>`
    SELECT item FROM powersync.tasks WHERE id = ${taskId}
  `
  const item = rows[0]?.item
  if (!item) {
    throw new Error(`Task ${taskId} not found`)
  }
  return item
}

export const waitForEncryptedSetting = async (userId: string, key: string): Promise<void> => {
  await poll(async () => {
    const rows = await sql<{ value: string | null }[]>`
      SELECT value
      FROM powersync.settings
      WHERE user_id = ${userId} AND id = ${key}
    `
    return rows[0]?.value?.startsWith('__enc:v2:0:') ? true : null
  }, 30_000)
}

/**
 * Read one settings row exactly as it sits on the server. Used by
 * `waitForTasksPreference`'s failure diagnostics to tell "the account's value was
 * overwritten" apart from "the value is fine but this device can't read it".
 */
export const getServerSetting = async (userId: string, key: string): Promise<string | null> => {
  const rows = await sql<{ value: string | null }[]>`
    SELECT value
    FROM powersync.settings
    WHERE user_id = ${userId} AND id = ${key}
  `
  return rows[0]?.value ?? null
}

export const waitForNewEncryptedTasks = async (
  userId: string,
  baselineIds: ReadonlySet<string>,
): Promise<EncryptedTaskRow[]> =>
  poll(async () => {
    const rows = await sql<EncryptedTaskRow[]>`
      SELECT id, item
      FROM powersync.tasks
      WHERE user_id = ${userId} AND deleted_at IS NULL
    `
    const newRows = rows.filter((row) => !baselineIds.has(row.id))
    return newRows.length > 0 ? newRows : null
  }, 30_000)

export const waitForAccountDeletion = async (userId: string): Promise<void> => {
  await poll(async () => {
    const rows = await sql<
      { user_count: number; encryption_count: number; device_count: number; session_count: number }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM "user" WHERE id = ${userId}) AS user_count,
        (
          (SELECT COUNT(*) FROM encryption_metadata WHERE user_id = ${userId}) +
          (SELECT COUNT(*) FROM wrapped_keys WHERE user_id = ${userId}) +
          (SELECT COUNT(*) FROM envelopes WHERE user_id = ${userId}) +
          (SELECT COUNT(*) FROM challenge_nonces WHERE user_id = ${userId})
        )::int AS encryption_count,
        (SELECT COUNT(*)::int FROM powersync.devices WHERE user_id = ${userId}) AS device_count,
        (SELECT COUNT(*)::int FROM session WHERE user_id = ${userId}) AS session_count
    `
    const row = rows[0]
    return row &&
      row.user_count === 0 &&
      row.encryption_count === 0 &&
      row.device_count === 0 &&
      row.session_count === 0
      ? true
      : null
  }, 30_000)
}

// =============================================================================
// Adversary primitives (A2 — malicious / compelled / breached server)
// =============================================================================

/**
 * One cell in a synced table, addressed the way the server sees it. `table` is a
 * `powersync` schema table and `column` one of its columns — the pairs in
 * `encryptedColumnsMap` are the interesting ones.
 */
export type CellRef = {
  table: string
  rowId: string
  column: string
}

/** Read a cell exactly as stored, with no decryption. */
export const readCell = async ({ table, rowId, column }: CellRef): Promise<string | null> => {
  const rows = await sql<{ value: string | null }[]>`
    SELECT ${sql(column)} AS value
    FROM powersync.${sql(table)}
    WHERE id = ${rowId}
  `
  if (rows.length === 0) {
    throw new Error(`${table}.${column}: row ${rowId} not found`)
  }
  return rows[0].value
}

/**
 * Takes the connection to run on so a caller inside `sql.begin` can pass the
 * transaction handle. The pool is `max: 1`: a query issued on the outer `sql`
 * while a transaction holds that connection waits for one that never frees.
 */
const updateCell = async (
  handle: postgres.Sql | postgres.TransactionSql,
  { table, rowId, column }: CellRef,
  value: string | null,
): Promise<void> => {
  const result = await handle`
    UPDATE powersync.${handle(table)}
    SET ${handle(column)} = ${value}
    WHERE id = ${rowId}
  `
  if (result.count === 0) {
    throw new Error(`${table}.${column}: row ${rowId} not found`)
  }
}

/**
 * Overwrite a cell behind the client's back — the core A2 capability. Bypasses
 * the API, PowerSync's upload path, and every client-side guard, which is the
 * point: it models a server that has decided to lie.
 */
export const writeCell = async (ref: CellRef, value: string | null): Promise<void> => {
  await updateCell(sql, ref, value)
}

/**
 * Exchange two cells' stored values — ciphertext substitution (C3). Works across
 * rows, tables and accounts; whether the client notices is what the AAD binding
 * is meant to decide.
 *
 * Both reads happen before the transaction opens, for the `max: 1` reason above.
 */
export const swapCells = async (a: CellRef, b: CellRef): Promise<void> => {
  const [valueA, valueB] = await Promise.all([readCell(a), readCell(b)])
  await sql.begin(async (tx) => {
    await updateCell(tx, a, valueB)
    await updateCell(tx, b, valueA)
  })
}

/**
 * The account-wide ECDSA public key the server checks every challenge proof
 * against. Deliberately not folded into `EncryptionServerSnapshot`: specs assert
 * on that shape, and this is the one field a C5 attack cares about.
 */
export const getSigningPublicKey = async (userId: string): Promise<string | null> => {
  const rows = await sql<{ signing_public_key: string | null }[]>`
    SELECT signing_public_key FROM encryption_metadata WHERE user_id = ${userId}
  `
  return rows[0]?.signing_public_key ?? null
}

/** Live sessions for one device — revocation is expected to leave none. */
export const countDeviceSessions = async (userId: string, deviceId: string): Promise<number> => {
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM session
    WHERE user_id = ${userId} AND device_id = ${deviceId}
  `
  return rows[0]?.count ?? 0
}
