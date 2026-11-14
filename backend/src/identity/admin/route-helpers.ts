/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { APIError } from 'better-auth'
import { type ErrorHandler, t } from 'elysia'
import type { AuditAction } from '../audit/events'
import { recordFailedAttempt } from '../audit/write'
import { assignableRoles } from '../roles'
import { inputConflictCodes, toAdminErrorResponse } from './errors'
import { decodeCursor, decodeTimestampCursor } from './pagination'

/** A role an admin can grant or map: one the system knows. */
export const assignableRoleSchema = t.Union(assignableRoles.map((role) => t.Literal(role)))

/**
 * The first error handler of every admin route group: identity service errors keep their status
 * and code. Anything else falls through to `safeErrorHandler`, registered after it. It reads only
 * `error` and `set`: a handler that takes the whole context makes Elysia parse every request body,
 * app-wide, which breaks routes that read the raw body themselves.
 */
export const adminErrorHandler: ErrorHandler = ({ error, set }) => {
  const response = toAdminErrorResponse(error)
  if (!response) {
    return
  }
  set.status = response.status
  return response.body
}

/** Refusals that are policy, not input: a conflict with the rules, or an admin acting on themselves. */
const isPolicyRefusal = ({ status, body }: NonNullable<ReturnType<typeof toAdminErrorResponse>>) =>
  ((status === 403 || status === 409) && !inputConflictCodes.has(body.code)) || body.code === 'PURGE_SELF'

type DeniedAttempt = { action: AuditAction; actorId: string; target: { type: string; id?: string | null } }

/**
 * Run an admin change, and when a policy refuses it, record the denied attempt before the error
 * reaches the handler. Use it only where the service doesn't record its own refusals.
 */
export const auditRefusals = async <T>(
  database: QueryableDatabase,
  { action, actorId, target }: DeniedAttempt,
  change: () => Promise<T>,
): Promise<T> => {
  try {
    return await change()
  } catch (error) {
    const response = toAdminErrorResponse(error)
    if (response && isPolicyRefusal(response)) {
      await recordFailedAttempt(database, {
        action,
        outcome: 'denied',
        reason: response.body.code,
        actor: { type: 'user', id: actorId },
        target,
      })
    }
    throw error
  }
}

const invalidCursor = () => new APIError('BAD_REQUEST', { message: 'Invalid cursor', code: 'INVALID_CURSOR' })

/** Decode a list's cursor into its parts; a cursor that isn't one of ours is a 400 `INVALID_CURSOR`. */
export const cursorParts = (cursor: string | undefined, length: number) => {
  if (cursor === undefined) {
    return undefined
  }
  const parts = decodeCursor(cursor, length)
  if (!parts) {
    throw invalidCursor()
  }
  return parts
}

/** Decode a newest-first `[timestamp, id]` cursor; one that isn't ours is a 400 `INVALID_CURSOR`. */
export const timestampCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return undefined
  }
  const parts = decodeTimestampCursor(cursor)
  if (!parts) {
    throw invalidCursor()
  }
  return parts
}
