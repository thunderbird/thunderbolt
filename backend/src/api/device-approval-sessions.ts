/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Relay for the short-code device approval (commit-then-reveal). The pending device commits,
 * a trusted device challenges, the pending device reveals; both then derive the same 2-digit
 * code locally. The code's security does not rely on the server, because the commitment stops it
 * from steering the code. These routes only enforce ownership, ordering and single use.
 * `POST /devices/:deviceId/envelope` and its proof + attestation gate are unchanged.
 */

import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import {
  getApprovalSession,
  getDeviceById,
  isTrustedAppDevice,
  setApprovalChallenge,
  setApprovalReveal,
  upsertApprovalSession,
} from '@/dal'
import { safeErrorHandler } from '@/middleware/error-handling'
import { approvalSessionTtlMs } from '@shared/e2ee-types'
import { Elysia, t } from 'elysia'
import { getCallerDevice } from './encryption'

const sessionIdSchema = t.String({ pattern: '^[0-9a-f]{32}$' })
const hex64Schema = t.String({ pattern: '^[0-9a-f]{64}$' })

type DeviceRow = NonNullable<Awaited<ReturnType<typeof getDeviceById>>>

const isPendingAppDevice = (device: DeviceRow): boolean =>
  device.approvalPending && !device.trusted && device.revokedAt == null && device.deviceType !== 'cli'

const isExpired = (session: { expiresAt: Date }): boolean => session.expiresAt.getTime() <= Date.now()

/** Resolve a pending caller (the new device). */
const resolvePendingCaller = async (
  database: typeof DbType,
  userId: string,
  request: Request,
  session: { deviceId?: string | null },
) => {
  const caller = await getCallerDevice(database, userId, request, session)
  if ('error' in caller) {
    return caller
  }
  if (!isPendingAppDevice(caller.device)) {
    return { status: 409 as const, error: 'Device is not pending approval' }
  }
  return caller
}

/** Resolve a trusted caller acting on one of the same account's pending devices. */
const resolveApprover = async (
  database: typeof DbType,
  userId: string,
  request: Request,
  session: { deviceId?: string | null },
  targetDeviceId: string,
) => {
  const caller = await getCallerDevice(database, userId, request, session)
  if ('error' in caller) {
    return caller
  }
  if (!isTrustedAppDevice(caller.device, userId)) {
    return { status: 403 as const, error: 'Only trusted devices can approve pending devices' }
  }
  const target = await getDeviceById(database, targetDeviceId)
  if (!target || target.userId !== userId || !isPendingAppDevice(target)) {
    return { status: 404 as const, error: 'Device not found' }
  }
  return { callerDeviceId: caller.deviceId }
}

export const createDeviceApprovalSessionRoutes = (auth: Auth, database: typeof DbType) =>
  new Elysia()
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .post(
      '/devices/me/approval-session',
      async ({ body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const caller = await resolvePendingCaller(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }
        await upsertApprovalSession(database, {
          deviceId: caller.deviceId,
          sessionId: body.sessionId,
          commitment: body.commitment,
          expiresAt: new Date(Date.now() + approvalSessionTtlMs),
        })
        set.status = 204
      },
      { auth: true, body: t.Object({ sessionId: sessionIdSchema, commitment: hex64Schema }) },
    )
    .get(
      '/devices/me/approval-session',
      async ({ request, set, user: sessionUser, session }) => {
        const caller = await resolvePendingCaller(database, sessionUser!.id, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }
        const row = await getApprovalSession(database, caller.deviceId)
        if (!row) {
          set.status = 404
          return { error: 'Approval session not found' }
        }
        return {
          sessionId: row.sessionId,
          challenge: row.challenge,
          challengerDeviceId: row.challengerDeviceId,
          expired: isExpired(row),
        }
      },
      { auth: true },
    )
    .post(
      '/devices/me/approval-session/reveal',
      async ({ body, request, set, user: sessionUser, session }) => {
        const caller = await resolvePendingCaller(database, sessionUser!.id, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }
        const rows = await setApprovalReveal(database, {
          deviceId: caller.deviceId,
          sessionId: body.sessionId,
          reveal: body.reveal,
        })
        if (rows.length === 0) {
          set.status = 409
          return { error: 'Approval session cannot be revealed' }
        }
        set.status = 204
      },
      { auth: true, body: t.Object({ sessionId: sessionIdSchema, reveal: hex64Schema }) },
    )
    .get(
      '/devices/:deviceId/approval-session',
      async ({ params, request, set, user: sessionUser, session }) => {
        const approver = await resolveApprover(database, sessionUser!.id, request, session, params.deviceId)
        if ('error' in approver) {
          set.status = approver.status
          return { error: approver.error }
        }
        const row = await getApprovalSession(database, params.deviceId)
        if (!row) {
          set.status = 404
          return { error: 'Approval session not found' }
        }
        return { sessionId: row.sessionId, commitment: row.commitment, reveal: row.reveal, expired: isExpired(row) }
      },
      { auth: true },
    )
    .post(
      '/devices/:deviceId/approval-session/challenge',
      async ({ params, body, request, set, user: sessionUser, session }) => {
        const approver = await resolveApprover(database, sessionUser!.id, request, session, params.deviceId)
        if ('error' in approver) {
          set.status = approver.status
          return { error: approver.error }
        }
        const rows = await setApprovalChallenge(database, {
          deviceId: params.deviceId,
          sessionId: body.sessionId,
          challenge: body.challenge,
          challengerDeviceId: approver.callerDeviceId,
        })
        if (rows.length === 0) {
          set.status = 409
          return { error: 'Approval session cannot be challenged' }
        }
        set.status = 204
      },
      { auth: true, body: t.Object({ sessionId: sessionIdSchema, challenge: hex64Schema }) },
    )
