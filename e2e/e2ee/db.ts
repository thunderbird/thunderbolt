/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import postgres from 'postgres'

const postgresPort = process.env.E2E_POSTGRES_PORT ?? '5434'
const sql = postgres(`postgresql://postgres:postgres@localhost:${postgresPort}/postgres`, {
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

/** Close the PostgreSQL fixture connection after the Playwright worker finishes. */
export const closeE2eeDb = async (): Promise<void> => {
  await sql.end()
}

/** Read the current plaintext development OTP from the isolated test database. */
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

/** Read an existing OTP before requesting a replacement for the same account. */
export const getCurrentOtp = async (email: string): Promise<string | null> => {
  const rows = await sql<{ value: string }[]>`
    SELECT value
    FROM verification
    WHERE identifier = ${`sign-in-otp-${email}`}
    LIMIT 1
  `
  return rows[0]?.value ?? null
}

/** Resolve the Better Auth user ID created by the consumer OTP flow. */
export const waitForUserId = async (email: string): Promise<string> =>
  poll(async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM "user" WHERE email = ${email} LIMIT 1
    `
    return rows[0]?.id ?? null
  })

export type FirstDeviceServerState = {
  keyVersion: number
  primaryKeyId: string
  wrappedKeyIds: string[]
  trustedDeviceCount: number
  envelopeCount: number
}

/** Wait until first-device E2EE metadata and its trusted envelope are durable. */
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

/** Snapshot server task IDs before creating the test-specific task. */
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

export type DeviceServerState = {
  id: string
  trusted: boolean
  approvalPending: boolean
  revokedAt: Date | null
  hasEnvelope: boolean
}

/** Wait for a device registration to reach a caller-defined lifecycle state. */
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

export type EncryptionServerSnapshot = {
  keyVersion: number
  primaryKeyId: string
  wrappedKeys: Record<string, string>
  envelopes: Record<string, string>
}

/** Snapshot keyring and envelope bytes to prove rotations changed only key wrapping. */
export const getEncryptionServerSnapshot = async (userId: string): Promise<EncryptionServerSnapshot> => {
  const metadata = await sql<{ key_version: number; primary_key_id: string }[]>`
    SELECT key_version, primary_key_id FROM encryption_metadata WHERE user_id = ${userId}
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
    wrappedKeys: Object.fromEntries(wrappedKeys.map((row) => [row.key_id, row.wrapped_key])),
    envelopes: Object.fromEntries(envelopes.map((row) => [row.device_id, row.wrapped_ck])),
  }
}

/** Wait for a challenge proof to be consumed by a sensitive operation. */
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

/** Read a persisted task ciphertext by row ID. */
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

/** Seed the minimal legacy metadata shape used by the supported v1 reset flow. */
export const seedV1EncryptionMetadata = async (userId: string): Promise<void> => {
  await sql`
    INSERT INTO encryption_metadata (user_id, canary_iv, canary_ctext)
    VALUES (${userId}, 'legacy-iv', 'legacy-ciphertext')
  `
}

/** Wait until account deletion cascades through all E2EE server tables. */
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

/** Wait for a named settings row to reach PostgreSQL as E2EE ciphertext. */
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

/** Wait for at least one new PowerSync task row after the supplied baseline. */
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
