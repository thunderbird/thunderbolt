import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import type { db as DbType } from '@/db/client'
import {
  powersyncConflictTarget,
  powersyncDbNameToSchemaKey,
  powersyncPkColumn,
  powersyncTablesByName,
} from '@/db/powersync-schema'
import { devicesTable } from '@/db/schema'
import { type PowerSyncTableName, powersyncTableNames } from '@shared/powersync-tables'
import { jwt } from '@elysiajs/jwt'
import { and, eq, gt } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'
import { Elysia, t } from 'elysia'

const validTables = new Set<string>(powersyncTableNames)

/**
 * PowerSync operation types from the upload queue
 */
type PowerSyncOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string // table name
  id: string
  data?: Record<string, unknown>
}

/** DB column names that use Drizzle timestamp(); JSON sends them as ISO strings, so we convert to Date. */
const TIMESTAMP_DB_COLUMNS = new Set(['deleted_at', 'last_seen', 'created_at', 'revoked_at', 'updated_at'])

/**
 * Convert payload with DB column names to schema keys and filter to valid columns only.
 * Timestamp columns arrive as ISO strings from JSON; convert to Date for Drizzle.
 */
const toSchemaRecord = (
  dbRecord: Record<string, unknown>,
  validDbNames: Set<string>,
  dbNameToKey: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [dbName, value] of Object.entries(dbRecord)) {
    if (!validDbNames.has(dbName)) continue
    const schemaKey = dbNameToKey[dbName]
    if (schemaKey && value !== undefined) {
      let mapped = value
      if (TIMESTAMP_DB_COLUMNS.has(dbName) && typeof value === 'string') {
        const d = new Date(value)
        mapped = Number.isNaN(d.getTime()) ? value : d
      }
      out[schemaKey] = mapped
    }
  }
  return out
}

type DeviceValidationResult =
  | { ok: true }
  | { ok: false; status: 400; body: { code: 'DEVICE_ID_REQUIRED' } }
  | { ok: false; status: 403; body: { code: 'DEVICE_DISCONNECTED' } }
  | { ok: false; status: 409; body: { code: 'DEVICE_ID_TAKEN' } }

type IssuePowerSyncTokenResult =
  | { ok: true; token: string; expiresAt: string; powerSyncUrl: string }
  | { ok: false; status: 400; body: { code: 'DEVICE_ID_REQUIRED' } }
  | { ok: false; status: 403; body: { code: 'DEVICE_DISCONNECTED' } }
  | { ok: false; status: 409; body: { code: 'DEVICE_ID_TAKEN' } }

/**
 * Validates that the device is not revoked and belongs to the user.
 * Requires x-device-id so revoked devices cannot bypass by omitting it.
 */
const validateDeviceNotRevoked = async (
  userId: string,
  request: Request,
  database: typeof DbType,
): Promise<DeviceValidationResult> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId) {
    return { ok: false, status: 400, body: { code: 'DEVICE_ID_REQUIRED' } }
  }

  const deviceRow = await database
    .select({ userId: devicesTable.userId, revokedAt: devicesTable.revokedAt })
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId))
    .limit(1)
    .then((rows) => rows[0])

  if (deviceRow) {
    if (deviceRow.userId !== userId) {
      return { ok: false, status: 409, body: { code: 'DEVICE_ID_TAKEN' } }
    }
    if (deviceRow.revokedAt != null) {
      return { ok: false, status: 403, body: { code: 'DEVICE_DISCONNECTED' } }
    }
  }

  return { ok: true }
}

/**
 * Shared logic for issuing a PowerSync JWT: device revocation check, JWT signing, device upsert.
 * Used by both session-based and bearer-only token paths.
 * Requires x-device-id so revocation can always be enforced; a revoked device cannot bypass by omitting it.
 */
const issuePowerSyncToken = async (
  userId: string,
  request: Request,
  powersyncJwt: { sign: (payload: { sub: string; user_id: string }) => Promise<string> },
  settings: Settings,
  database: typeof DbType,
): Promise<IssuePowerSyncTokenResult> => {
  const validation = await validateDeviceNotRevoked(userId, request, database)
  if (!validation.ok) {
    return validation
  }

  const deviceId = request.headers.get('x-device-id')!.trim()
  const rawDeviceName = request.headers.get('x-device-name')?.trim()
  const deviceName =
    rawDeviceName && rawDeviceName.length > 0 && rawDeviceName.length <= 100 ? rawDeviceName : 'Unknown device'

  const now = new Date()
  const upserted = await database
    .insert(devicesTable)
    .values({
      id: deviceId,
      userId,
      name: deviceName,
      lastSeen: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: { lastSeen: now, name: deviceName },
      setWhere: eq(devicesTable.userId, userId),
    })
    .returning()

  if (upserted.length === 0 || upserted[0].userId !== userId) {
    return { ok: false, status: 409, body: { code: 'DEVICE_ID_TAKEN' } }
  }

  const token = await powersyncJwt.sign({ sub: userId, user_id: userId })
  const expiresAt = new Date(Date.now() + settings.powersyncTokenExpirySeconds * 1000).toISOString()

  return { ok: true, token, expiresAt, powerSyncUrl: settings.powersyncUrl }
}

/**
 * Apply a single PowerSync operation using Drizzle's query builder (parameterized, no raw SQL).
 * The user_id is always set to the authenticated user to ensure data isolation.
 */
const applyOperation = async (op: PowerSyncOperation, userId: string, database: typeof DbType): Promise<boolean> => {
  if (!validTables.has(op.type)) {
    return false
  }

  const tableName = op.type as PowerSyncTableName
  const table = powersyncTablesByName[tableName]
  const dbNameToKey = powersyncDbNameToSchemaKey[tableName]
  const pkColumn = powersyncPkColumn[tableName]
  const conflictTarget = powersyncConflictTarget[tableName]
  if (!table || !dbNameToKey || !pkColumn || !conflictTarget) return false

  const validDbNames = new Set(Object.keys(dbNameToKey))
  const tableWithUserId = table as AnyPgTable & { userId: typeof table.userId }

  switch (op.op) {
    case 'PUT': {
      const payload = { ...(op.data ?? {}) } as Record<string, unknown>
      delete payload.id
      delete payload.user_id
      const rawData: Record<string, unknown> = { ...payload, id: op.id, user_id: userId }
      const schemaValues = toSchemaRecord(rawData, validDbNames, dbNameToKey)
      if (Object.keys(schemaValues).length === 0) return false

      const updateSet = { ...schemaValues }
      delete updateSet.id
      delete updateSet.key
      delete updateSet.userId

      const insertQuery = database.insert(table).values(schemaValues as never)
      if (Object.keys(updateSet).length > 0) {
        await insertQuery.onConflictDoUpdate({
          target: conflictTarget,
          set: updateSet as never,
          setWhere: eq(tableWithUserId.userId, userId),
        })
      } else {
        await insertQuery.onConflictDoNothing({ target: conflictTarget })
      }
      return true
    }
    case 'PATCH': {
      if (!op.data || Object.keys(op.data).length === 0) {
        return true // no-op: nothing to update
      }
      const patchPayload = { ...op.data } as Record<string, unknown>
      delete patchPayload.id
      delete patchPayload.user_id
      const schemaPatch = toSchemaRecord(patchPayload, validDbNames, dbNameToKey)
      if (Object.keys(schemaPatch).length === 0) return false

      const patched = await database
        .update(table)
        .set(schemaPatch as never)
        .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, userId)))
        .returning()

      return patched.length > 0
    }
    case 'DELETE': {
      const deleted = await database
        .delete(table)
        .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, userId)))
        .returning()

      return deleted.length > 0
    }
  }
  return false
}

/**
 * PowerSync API routes for JWT token generation and data sync.
 *
 * GET /token: Issues a PowerSync JWT so the client can connect. Two auth paths:
 * - Session (cookie/header): user from derive; we check device revoked, upsert device, then issue token.
 * - Bearer token only (credential refresh): resolve session → user; 410 if user deleted, else issue new JWT and return 200.
 * Requires x-device-id so revocation is always enforced (revoked device cannot bypass by omitting it).
 * Status codes: 400 = x-device-id missing/empty; 410 = account deleted; 403 = device revoked (client should reset); 401 = no/invalid Bearer token.
 *
 * PUT /upload: Applies batched CRUD from PowerSync; requires authenticated user.
 *
 * Returns an empty Elysia instance if PowerSync is not configured.
 */
export const createPowerSyncRoutes = (auth: Auth, settings: Settings, database: typeof DbType) => {
  if (!settings.powersyncJwtSecret) {
    console.warn('PowerSync is not configured, skipping PowerSync routes')
    return new Elysia({ prefix: '/powersync' })
  }

  return new Elysia({ prefix: '/powersync' })
    .use(
      jwt({
        name: 'powersyncJwt',
        secret: settings.powersyncJwtSecret,
        exp: `${settings.powersyncTokenExpirySeconds}s`,
        aud: 'powersync',
        kid: settings.powersyncJwtKid,
      }),
    )
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      return { user: session?.user ?? null }
    })
    .get('/token', async ({ powersyncJwt, request, set, user }) => {
      if (!settings.powersyncUrl || !settings.powersyncJwtSecret) {
        set.status = 503
        return { error: 'PowerSync is not configured' }
      }

      // Path 1: Authenticated via session. Issue PowerSync JWT; check device revoked, then upsert device.
      if (user) {
        const result = await issuePowerSyncToken(user.id, request, powersyncJwt, settings, database)
        if (!result.ok) {
          set.status = result.status
          return result.body
        }
        return { token: result.token, expiresAt: result.expiresAt, powerSyncUrl: result.powerSyncUrl }
      }

      // Path 2: No session; Bearer token only. Resolve session → user; 410 if user deleted (e.g. account deleted elsewhere).
      const authHeader = request.headers.get('authorization')
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
      if (!bearerToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const sessionRow = await database
        .select({ userId: sessionTable.userId })
        .from(sessionTable)
        .where(and(eq(sessionTable.token, bearerToken), gt(sessionTable.expiresAt, new Date())))
        .limit(1)
        .then((rows) => rows[0])
      if (!sessionRow) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const userRow = await database
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.id, sessionRow.userId))
        .limit(1)
        .then((rows) => rows[0])
      if (!userRow) {
        set.status = 410
        return { code: 'ACCOUNT_DELETED' }
      }

      // Token refresh: valid Bearer + user exists → issue new PowerSync JWT (same as Path 1).
      const userId = sessionRow.userId
      const result = await issuePowerSyncToken(userId, request, powersyncJwt, settings, database)
      if (!result.ok) {
        set.status = result.status
        return result.body
      }
      return { token: result.token, expiresAt: result.expiresAt, powerSyncUrl: result.powerSyncUrl }
    })
    .put(
      '/upload',
      async ({ body, request, set, user }) => {
        // Requires authenticated user; applies batched CRUD from PowerSync.
        if (!user) {
          set.status = 401
          return { error: 'Unauthorized' }
        }

        const validation = await validateDeviceNotRevoked(user.id, request, database)
        if (!validation.ok) {
          set.status = validation.status
          return validation.body
        }

        const operations = body.operations as PowerSyncOperation[]

        if (!Array.isArray(operations)) {
          set.status = 400
          return { error: 'Invalid request: operations must be an array' }
        }

        // Process operations sequentially to maintain order.
        // If any operation fails, return 4xx so the client does not call transaction.complete()
        // and PowerSync will retry the batch.
        for (const op of operations) {
          const ok = await applyOperation(op, user.id, database)
          if (!ok) {
            set.status = 400
            return {
              error: 'Upload operation failed',
              code: 'UPLOAD_OPERATION_FAILED',
              table: op.type,
              id: op.id,
              op: op.op,
            }
          }
        }

        return { success: true }
      },
      {
        body: t.Object({
          operations: t.Array(
            t.Object({
              op: t.Union([t.Literal('PUT'), t.Literal('PATCH'), t.Literal('DELETE')]),
              type: t.String(),
              id: t.String(),
              data: t.Optional(t.Record(t.String(), t.Unknown())),
            }),
          ),
        }),
      },
    )
}
