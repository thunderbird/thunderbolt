import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { isOriginAllowed } from '@/config/settings'
import { applyOperation, getActiveSessionByToken, getDeviceById, getUserById, upsertDevice } from '@/dal'
import type { db as DbType } from '@/db/client'
import { verifySignedBearerToken } from '@/auth/bearer-token'
import { jwt } from '@elysiajs/jwt'
import { Elysia, t } from 'elysia'

type DeviceValidationResult =
  | { ok: true }
  | { ok: false; status: 400; body: { code: 'DEVICE_ID_REQUIRED' } }
  | { ok: false; status: 403; body: { code: 'DEVICE_DISCONNECTED' | 'DEVICE_NOT_TRUSTED' } }
  | { ok: false; status: 409; body: { code: 'DEVICE_ID_TAKEN' } }

type IssuePowerSyncTokenResult =
  | { ok: true; token: string; expiresAt: string; powerSyncUrl: string }
  | { ok: false; status: 400; body: { code: 'DEVICE_ID_REQUIRED' } }
  | { ok: false; status: 403; body: { code: 'DEVICE_DISCONNECTED' | 'DEVICE_NOT_TRUSTED' } }
  | { ok: false; status: 409; body: { code: 'DEVICE_ID_TAKEN' } }

/**
 * Validates that the device belongs to the user, is trusted, and is not revoked.
 * Untrusted devices (pending approval) cannot sync — they use HTTP APIs for the
 * key setup flow and only need sync after receiving the CK.
 */
const validateDeviceForSync = async (
  userId: string,
  request: Request,
  database: typeof DbType,
): Promise<DeviceValidationResult> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId) {
    return { ok: false, status: 400, body: { code: 'DEVICE_ID_REQUIRED' } }
  }

  const deviceRow = await getDeviceById(database, deviceId)

  if (deviceRow) {
    if (deviceRow.userId !== userId) {
      return { ok: false, status: 409, body: { code: 'DEVICE_ID_TAKEN' } }
    }
    if (deviceRow.revokedAt != null) {
      return { ok: false, status: 403, body: { code: 'DEVICE_DISCONNECTED' } }
    }
    if (!deviceRow.trusted) {
      return { ok: false, status: 403, body: { code: 'DEVICE_NOT_TRUSTED' } }
    }
  }

  return { ok: true }
}

/**
 * Defense-in-depth: rejects cross-origin requests whose Origin doesn't match allowed CORS origins.
 * Absent Origin (non-browser / server-to-server clients) is allowed.
 */
const validateOrigin = (request: Request, appSettings: Settings): boolean => {
  const origin = request.headers.get('origin')
  if (!origin) return true
  return isOriginAllowed(origin, appSettings)
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
  const validation = await validateDeviceForSync(userId, request, database)
  if (!validation.ok) {
    return validation
  }

  const deviceId = request.headers.get('x-device-id')!.trim()
  const rawDeviceName = request.headers.get('x-device-name')?.trim()
  const deviceName =
    rawDeviceName && rawDeviceName.length > 0 && rawDeviceName.length <= 100 ? rawDeviceName : 'Unknown device'

  const now = new Date()
  const upserted = await upsertDevice(database, {
    id: deviceId,
    userId,
    name: deviceName,
    lastSeen: now,
    createdAt: now,
  })

  if (upserted.length === 0 || upserted[0].userId !== userId) {
    return { ok: false, status: 409, body: { code: 'DEVICE_ID_TAKEN' } }
  }

  const token = await powersyncJwt.sign({ sub: userId, user_id: userId })
  const expiresAt = new Date(Date.now() + settings.powersyncTokenExpirySeconds * 1000).toISOString()

  return { ok: true, token, expiresAt, powerSyncUrl: settings.powersyncUrl }
}

/**
 * PowerSync API routes for JWT token generation and data sync.
 *
 * GET /token: Issues a PowerSync JWT so the client can connect. Two auth paths:
 * - Session (cookie/header): user from derive; we check device revoked, upsert device, then issue token.
 * - Bearer token only (credential refresh): resolve session -> user; 410 if user deleted, else issue new JWT and return 200.
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
      if (!validateOrigin(request, settings)) {
        set.status = 403
        return { error: 'Forbidden', code: 'ORIGIN_NOT_ALLOWED' }
      }

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

      // Path 2: No session; Bearer token only. Resolve session -> user; 410 if user deleted (e.g. account deleted elsewhere).
      // The bearer plugin requires signed tokens (requireSignature: true), so we must verify
      // the signature here too — otherwise an attacker with a raw session token can bypass
      // signature verification by hitting Path 2 directly.
      const authHeader = request.headers.get('authorization')
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
      if (!bearerToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const rawToken = verifySignedBearerToken(bearerToken, settings.betterAuthSecret)
      if (!rawToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const sessionRow = await getActiveSessionByToken(database, rawToken)
      if (!sessionRow) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const userRow = await getUserById(database, sessionRow.userId)
      if (!userRow) {
        set.status = 410
        return { code: 'ACCOUNT_DELETED' }
      }

      // Token refresh: valid Bearer + user exists -> issue new PowerSync JWT (same as Path 1).
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
        if (!validateOrigin(request, settings)) {
          set.status = 403
          return { error: 'Forbidden', code: 'ORIGIN_NOT_ALLOWED' }
        }

        // Requires authenticated user; applies batched CRUD from PowerSync.
        if (!user) {
          set.status = 401
          return { error: 'Unauthorized' }
        }

        const validation = await validateDeviceForSync(user.id, request, database)
        if (!validation.ok) {
          set.status = validation.status
          return validation.body
        }

        const operations = body.operations

        // Process operations sequentially to maintain order.
        // If any operation fails, return 4xx so the client does not call transaction.complete()
        // and PowerSync will retry the batch.
        for (const op of operations) {
          const ok = await applyOperation(database, op, user.id)
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
