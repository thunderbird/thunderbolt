import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { db } from '@/db/client'
import { devicesTable } from '@/db/schema'
import { POWERSYNC_TABLE_NAMES } from '@shared/powersync-tables'
import { jwt } from '@elysiajs/jwt'
import { eq, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

const VALID_TABLES = new Set<string>(POWERSYNC_TABLE_NAMES)

/**
 * PowerSync operation types from the upload queue
 */
type PowerSyncOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string // table name
  id: string
  data?: Record<string, unknown>
}

/**
 * Escape a SQL string value to prevent injection
 */
const escapeValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  // Escape single quotes by doubling them
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Apply a single PowerSync operation to the database using raw SQL.
 * The user_id is always set to the authenticated user to ensure data isolation.
 */
const applyOperation = async (op: PowerSyncOperation, userId: string): Promise<void> => {
  if (!VALID_TABLES.has(op.type)) {
    console.warn(`Unknown table: ${op.type}`)
    return
  }

  console.info(`Applying ${op.op} to ${op.type} with id=${op.id} for user=${userId}`)

  switch (op.op) {
    case 'PUT': {
      // INSERT or UPDATE - upsert the row
      // Merge id and user_id into data (user_id always set to authenticated user)
      const allData = { id: op.id, ...op.data, user_id: userId }
      const columns = Object.keys(allData)
        .map((k) => `"${k}"`)
        .join(', ')
      const values = Object.values(allData).map(escapeValue).join(', ')

      // Build UPDATE SET clause for all columns except id
      // Only update if the row belongs to this user
      const updateColumns = Object.keys(allData).filter((k) => k !== 'id')
      const updateClause =
        updateColumns.length > 0
          ? `DO UPDATE SET ${updateColumns.map((k) => `"${k}" = EXCLUDED."${k}"`).join(', ')} WHERE "${op.type}"."user_id" = ${escapeValue(userId)}`
          : 'DO NOTHING'

      const query = `INSERT INTO "${op.type}" (${columns}) VALUES (${values}) ON CONFLICT (id) ${updateClause}`
      console.info(`SQL: ${query}`)
      const result = await db.execute(sql.raw(query))
      console.info(`Result:`, result)
      break
    }
    case 'PATCH': {
      // UPDATE - update existing row (only if it belongs to this user)
      if (!op.data || Object.keys(op.data).length === 0) {
        console.warn('PATCH operation missing data')
        return
      }
      // Always set user_id to ensure ownership
      const dataWithUserId = { ...op.data, user_id: userId }
      const setClauses = Object.entries(dataWithUserId)
        .map(([key, value]) => `"${key}" = ${escapeValue(value)}`)
        .join(', ')

      const query = `UPDATE "${op.type}" SET ${setClauses} WHERE id = ${escapeValue(op.id)} AND user_id = ${escapeValue(userId)}`
      console.info(`SQL: ${query}`)
      const result = await db.execute(sql.raw(query))
      console.info(`Result:`, result)
      break
    }
    case 'DELETE': {
      // DELETE - remove row (only if it belongs to this user)
      const query = `DELETE FROM "${op.type}" WHERE id = ${escapeValue(op.id)} AND user_id = ${escapeValue(userId)}`
      console.info(`SQL: ${query}`)
      const result = await db.execute(sql.raw(query))
      console.info(`Result:`, result)
      break
    }
  }
}

/**
 * PowerSync API routes for JWT token generation and data sync.
 *
 * GET /token: Issues a PowerSync JWT so the client can connect. Two auth paths:
 * - Session (cookie/header): user from derive; we check device revoked, upsert device, then issue token.
 * - Bearer token only (e.g. PowerSync credential refresh): resolve session → user; 410 if user deleted, else 401.
 * Status codes: 410 = account deleted, 403 = device revoked (client should reset); 401 = generic auth failure (future: token refresh).
 *
 * PUT /upload: Applies batched CRUD from PowerSync; requires authenticated user.
 *
 * Returns an empty Elysia instance if PowerSync is not configured.
 */
export const createPowerSyncRoutes = (auth: Auth, settings: Settings): Elysia => {
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
        const deviceId = request.headers.get('x-device-id')
        if (deviceId) {
          const deviceRow = await db
            .select({ revokedAt: devicesTable.revokedAt })
            .from(devicesTable)
            .where(eq(devicesTable.id, deviceId))
            .limit(1)
            .then((rows) => rows[0])
          if (deviceRow?.revokedAt != null) {
            set.status = 403
            return { code: 'DEVICE_DISCONNECTED' }
          }
        }

        const token = await powersyncJwt.sign({
          sub: user.id,
          user_id: user.id,
        })
        const expiresAt = new Date(Date.now() + settings.powersyncTokenExpirySeconds * 1000).toISOString()

        const deviceName = request.headers.get('x-device-name')
        if (deviceId && deviceName) {
          const now = Math.floor(Date.now() / 1000)
          await db
            .insert(devicesTable)
            // Upsert device for Settings > Devices list and last-seen; synced via PowerSync.
            .values({
              id: deviceId,
              userId: user.id,
              name: deviceName,
              lastSeen: now,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: devicesTable.id,
              set: { lastSeen: now, name: deviceName },
            })
        }

        return { token, expiresAt, powerSyncUrl: settings.powersyncUrl }
      }

      // Path 2: No session; Bearer token only. Resolve session → user; 410 if user deleted (e.g. account deleted elsewhere).
      const authHeader = request.headers.get('authorization')
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
      if (!bearerToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const sessionRow = await db
        .select({ userId: sessionTable.userId })
        .from(sessionTable)
        .where(eq(sessionTable.token, bearerToken))
        .limit(1)
        .then((rows) => rows[0])
      if (!sessionRow) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const userRow = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.id, sessionRow.userId))
        .limit(1)
        .then((rows) => rows[0])
      if (!userRow) {
        set.status = 410
        return { code: 'ACCOUNT_DELETED' }
      }

      set.status = 401
      return { error: 'Unauthorized' }
    })
    .put(
      '/upload',
      async ({ body, set, user }) => {
        // Requires authenticated user; applies batched CRUD from PowerSync.
        if (!user) {
          set.status = 401
          return { error: 'Unauthorized' }
        }
        const operations = body.operations as PowerSyncOperation[]

        if (!Array.isArray(operations)) {
          set.status = 400
          return { error: 'Invalid request: operations must be an array' }
        }

        console.info(`Processing ${operations.length} PowerSync operations for user=${user.id}`)

        // Process operations sequentially to maintain order
        for (const op of operations) {
          try {
            await applyOperation(op, user.id)
          } catch (error) {
            console.error(`Failed to apply operation:`, op, error)
            // Continue processing other operations
            // PowerSync recommends returning 2xx even for validation errors
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
