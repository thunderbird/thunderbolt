import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { isOriginAllowed } from '@/config/settings'
import { applyOperation, getActiveSessionByToken, getDeviceById, getUserById, upsertDevice } from '@/dal'
import type { db as DbType } from '@/db/client'
import { verifySignedBearerToken } from '@/auth/bearer-token'
import { safeErrorHandler } from '@/middleware/error-handling'
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
 * Validates that the device belongs to the user, is not revoked, and (when E2EE is enabled) is trusted.
 * When E2EE is disabled, the trust check is skipped — devices don't go through the envelope flow.
 *
 * @param allowNewDevice When true and E2EE is off, a device that doesn't exist yet is allowed
 *   through (the caller is expected to create it via upsertDevice). Only the token endpoint sets
 *   this — upload always requires the device to already exist.
 */
const validateDeviceForSync = async (
  userId: string,
  request: Request,
  database: typeof DbType,
  { e2eeEnabled }: Pick<Settings, 'e2eeEnabled'>,
  { allowNewDevice = false } = {},
): Promise<DeviceValidationResult> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId) {
    return { ok: false, status: 400, body: { code: 'DEVICE_ID_REQUIRED' } }
  }

  const deviceRow = await getDeviceById(database, deviceId)

  if (!deviceRow) {
    // When E2EE is disabled, the FE never calls POST /devices to register, so the device
    // may not exist yet. Allow it through only for the token path — upsertDevice will create it.
    if (!e2eeEnabled && allowNewDevice) {
      return { ok: true }
    }
    return { ok: false, status: 403, body: { code: 'DEVICE_NOT_TRUSTED' } }
  }

  if (deviceRow.userId !== userId) {
    return { ok: false, status: 409, body: { code: 'DEVICE_ID_TAKEN' } }
  }
  if (deviceRow.revokedAt != null) {
    return { ok: false, status: 403, body: { code: 'DEVICE_DISCONNECTED' } }
  }
  if (e2eeEnabled && !deviceRow.trusted) {
    return { ok: false, status: 403, body: { code: 'DEVICE_NOT_TRUSTED' } }
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
  const validation = await validateDeviceForSync(userId, request, database, settings, { allowNewDevice: true })
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
    ...(!settings.e2eeEnabled ? { trusted: true } : {}),
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
    .onError(safeErrorHandler)
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

        const validation = await validateDeviceForSync(user.id, request, database, settings)
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
