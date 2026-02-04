import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { db } from '@/db/client'
import { jwt } from '@elysiajs/jwt'
import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

/**
 * Valid table names for PowerSync sync
 */
const VALID_TABLES = new Set([
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'mcp_servers',
  'prompts',
  'triggers',
  'modes',
])

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
 * All routes require authentication.
 * Returns an empty Elysia instance if PowerSync is not configured.
 */
export const createPowerSyncRoutes = (auth: Auth, settings: Settings) => {
  // Skip PowerSync routes if not configured
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
    .derive(async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers })

      if (!session) {
        set.status = 401
        return { user: null }
      }

      return { user: session.user }
    })
    .onBeforeHandle(({ user, set }) => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .get('/token', async ({ powersyncJwt, set, user }) => {
      // Check if PowerSync is configured
      if (!settings.powersyncUrl || !settings.powersyncJwtSecret) {
        set.status = 503
        return { error: 'PowerSync is not configured' }
      }

      // Generate JWT token for PowerSync with the authenticated user's ID
      const token = await powersyncJwt.sign({
        sub: user!.id,
        user_id: user!.id,
      })

      const expiresAt = new Date(Date.now() + settings.powersyncTokenExpirySeconds * 1000).toISOString()

      return {
        token,
        expiresAt,
        powerSyncUrl: settings.powersyncUrl,
      }
    })
    .put(
      '/upload',
      async ({ body, set, user }) => {
        // Process batch of operations from PowerSync client
        const operations = body.operations as PowerSyncOperation[]

        if (!Array.isArray(operations)) {
          set.status = 400
          return { error: 'Invalid request: operations must be an array' }
        }

        console.info(`Processing ${operations.length} PowerSync operations for user=${user!.id}`)

        // Process operations sequentially to maintain order
        for (const op of operations) {
          try {
            await applyOperation(op, user!.id)
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
