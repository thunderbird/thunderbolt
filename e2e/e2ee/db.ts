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
/** The harness Postgres connection string, as an operator would pass it to `--db-url`. */
export const databaseUrl = `postgresql://postgres:postgres@localhost:${postgresPort}/postgres`
const sql = postgres(databaseUrl, {
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
}

export const waitForFirstDeviceState = async (userId: string): Promise<FirstDeviceServerState> =>
  poll(async () => {
    const metadata = await sql<{ key_version: number; primary_key_id: string }[]>`
      SELECT key_version, primary_key_id
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
    }
  })

export type EncryptionServerSnapshot = {
  keyVersion: number
  primaryKeyId: string
  schemeVersion: number
  wrappedKeys: Record<string, string>
  envelopes: Record<string, string>
}

export const getEncryptionServerSnapshot = async (userId: string): Promise<EncryptionServerSnapshot> => {
  const metadata = await sql<{ key_version: number; primary_key_id: string; scheme_version: number }[]>`
    SELECT key_version, primary_key_id, scheme_version FROM encryption_metadata WHERE user_id = ${userId}
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
  }
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
    // Concurrent migrators reload and race their app-init flip; allow headroom
    // for the winner's CAS upgrade to land on a loaded CI runner.
  }, 150_000)
}

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

type OrgEnvelopeServerState = {
  wrappedAk: string
  kmsKeyFingerprint: string
}

/** Poll for the org escrow envelope persisted alongside an AK-producing operation. */
export const waitForOrgEnvelope = async (userId: string): Promise<OrgEnvelopeServerState> =>
  poll(async () => {
    const rows = await sql<{ wrapped_ak: string; kms_key_fingerprint: string }[]>`
      SELECT wrapped_ak, kms_key_fingerprint FROM org_envelopes WHERE user_id = ${userId}
    `
    const row = rows[0]
    if (!row) {
      return null
    }
    return { wrappedAk: row.wrapped_ak, kmsKeyFingerprint: row.kms_key_fingerprint }
  })

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
          (SELECT COUNT(*) FROM challenge_nonces WHERE user_id = ${userId}) +
          (SELECT COUNT(*) FROM org_envelopes WHERE user_id = ${userId})
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
