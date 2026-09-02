/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { session } from '@/db/auth-schema'
import { and, eq, gt, isNull, or } from 'drizzle-orm'

export type SessionDeviceBindingResult = { status: 'bound' } | { status: 'conflict' } | { status: 'invalid-session' }

/** Resolve an unexpired persisted Better Auth session from its raw database token. */
export const getActivePersistedSession = async (database: QueryableDatabase, rawToken: string) => {
  const rows = await database
    .select({ id: session.id, userId: session.userId, deviceId: session.deviceId })
    .from(session)
    .where(and(eq(session.token, rawToken), gt(session.expiresAt, new Date())))
    .limit(1)
  return rows[0] ?? null
}

/** Atomically bind and re-read only the non-secret identity fields needed to classify the result. */
export const linkSessionToDevice = async (
  database: QueryableDatabase,
  sessionId: string,
  deviceId: string,
  userId: string,
): Promise<SessionDeviceBindingResult> => {
  const activeAt = new Date()
  await database
    .update(session)
    .set({ deviceId })
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        gt(session.expiresAt, activeAt),
        or(isNull(session.deviceId), eq(session.deviceId, deviceId)),
      ),
    )

  const activeRows = await database
    .select({ deviceId: session.deviceId })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, activeAt)))
    .limit(1)
  const activeSession = activeRows[0]
  if (!activeSession) {
    return { status: 'invalid-session' }
  }
  if (activeSession.deviceId === deviceId) {
    return { status: 'bound' }
  }
  return activeSession.deviceId === null ? { status: 'invalid-session' } : { status: 'conflict' }
}

/** Revoke (delete) all sessions linked to a specific device for a given user. */
export const revokeDeviceSessions = async (database: QueryableDatabase, deviceId: string, userId: string) =>
  database.delete(session).where(and(eq(session.deviceId, deviceId), eq(session.userId, userId)))
