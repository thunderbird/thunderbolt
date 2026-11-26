/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { deviceApprovalSessionsTable } from '@/db/schema'
import { and, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm'

/**
 * Start (or restart) the pending device's approval session. A new `sessionId` replaces the row
 * and clears any challenge and reveal; re-posting the same `sessionId` is a no-op, so a duplicate
 * request (a remount, a retry) cannot wipe a challenge the trusted device already sent.
 */
export const upsertApprovalSession = async (
  database: QueryableDatabase,
  session: { deviceId: string; sessionId: string; commitment: string; expiresAt: Date },
) => {
  const fields = {
    sessionId: session.sessionId,
    commitment: session.commitment,
    challenge: null,
    challengerDeviceId: null,
    reveal: null,
    expiresAt: session.expiresAt,
    createdAt: new Date(),
  }
  await database
    .insert(deviceApprovalSessionsTable)
    .values({ deviceId: session.deviceId, ...fields })
    .onConflictDoUpdate({
      target: deviceApprovalSessionsTable.deviceId,
      set: fields,
      setWhere: ne(deviceApprovalSessionsTable.sessionId, session.sessionId),
    })
}

/** The device's current approval session, or null. */
export const getApprovalSession = async (database: QueryableDatabase, deviceId: string) =>
  database
    .select()
    .from(deviceApprovalSessionsTable)
    .where(eq(deviceApprovalSessionsTable.deviceId, deviceId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** First challenge wins: matches 0 rows once a challenge exists, the session changed, or it expired. */
export const setApprovalChallenge = async (
  database: QueryableDatabase,
  params: { deviceId: string; sessionId: string; challenge: string; challengerDeviceId: string },
) =>
  database
    .update(deviceApprovalSessionsTable)
    .set({ challenge: params.challenge, challengerDeviceId: params.challengerDeviceId })
    .where(
      and(
        eq(deviceApprovalSessionsTable.deviceId, params.deviceId),
        eq(deviceApprovalSessionsTable.sessionId, params.sessionId),
        isNull(deviceApprovalSessionsTable.challenge),
        gt(deviceApprovalSessionsTable.expiresAt, new Date()),
      ),
    )
    .returning()

/** Reveal once, and only after a challenge: matches 0 rows otherwise. */
export const setApprovalReveal = async (
  database: QueryableDatabase,
  params: { deviceId: string; sessionId: string; reveal: string },
) =>
  database
    .update(deviceApprovalSessionsTable)
    .set({ reveal: params.reveal })
    .where(
      and(
        eq(deviceApprovalSessionsTable.deviceId, params.deviceId),
        eq(deviceApprovalSessionsTable.sessionId, params.sessionId),
        isNotNull(deviceApprovalSessionsTable.challenge),
        isNull(deviceApprovalSessionsTable.reveal),
        gt(deviceApprovalSessionsTable.expiresAt, new Date()),
      ),
    )
    .returning()
