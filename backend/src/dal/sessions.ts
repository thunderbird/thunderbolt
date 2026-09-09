/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { session } from '@/db/auth-schema'
import { and, eq, gt, isNull, or } from 'drizzle-orm'

export type SessionDeviceBindingResult = { status: 'bound' } | { status: 'conflict' } | { status: 'invalid-session' }

/** Server-only marker assigned to device-grant sessions until CLI registration binds a real device. */
export const cliRegistrationPendingDeviceId = 'cli-registration-pending'

/** Resolve an unexpired persisted Better Auth session from its raw database token. */
export const getActivePersistedSession = async (database: QueryableDatabase, rawToken: string) => {
  const rows = await database
    .select({ id: session.id, userId: session.userId, deviceId: session.deviceId })
    .from(session)
    .where(and(eq(session.token, rawToken), gt(session.expiresAt, new Date())))
    .limit(1)
  return rows[0] ?? null
}

/** Bind a session, optionally replacing the marker reserved for CLI account registration. */
const bindSessionToDevice = async (
  database: QueryableDatabase,
  sessionId: string,
  deviceId: string,
  userId: string,
  replaceCliRegistrationMarker: boolean,
): Promise<SessionDeviceBindingResult> => {
  const activeAt = new Date()
  const bindableDeviceId = replaceCliRegistrationMarker
    ? or(isNull(session.deviceId), eq(session.deviceId, cliRegistrationPendingDeviceId), eq(session.deviceId, deviceId))
    : or(isNull(session.deviceId), eq(session.deviceId, deviceId))
  await database
    .update(session)
    .set({ deviceId })
    .where(
      and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, activeAt), bindableDeviceId),
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

/** Atomically bind an ordinary unbound session without replacing CLI registration state. */
export const linkSessionToDevice = async (
  database: QueryableDatabase,
  sessionId: string,
  deviceId: string,
  userId: string,
): Promise<SessionDeviceBindingResult> => bindSessionToDevice(database, sessionId, deviceId, userId, false)

/** Atomically bind a CLI device-grant session from the dedicated account registration flow. */
export const linkCliSessionToDevice = async (
  database: QueryableDatabase,
  sessionId: string,
  deviceId: string,
  userId: string,
): Promise<SessionDeviceBindingResult> => bindSessionToDevice(database, sessionId, deviceId, userId, true)

/** Revoke (delete) all sessions linked to a specific device for a given user. */
export const revokeDeviceSessions = async (database: QueryableDatabase, deviceId: string, userId: string) =>
  database.delete(session).where(and(eq(session.deviceId, deviceId), eq(session.userId, userId)))
