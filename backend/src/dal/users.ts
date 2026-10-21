/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { session, user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { and, eq, gt, gte, inArray, lt, notExists, or } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type * as schema from '@/db/schema'

/** Get a user by ID. Returns null if not found. */
export const getUserById = async (database: typeof DbType, id: string) =>
  database
    .select({ id: user.id, isAnonymous: user.isAnonymous })
    .from(user)
    .where(eq(user.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Get a user by email. Returns null if not found. */
export const getUserByEmail = async (database: typeof DbType, email: string) =>
  database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Hard-delete a user. Cascades to all related tables via FK constraints. */
export const deleteUser = async (database: typeof DbType, id: string) => database.delete(user).where(eq(user.id, id))

/** Mark a user as no longer new (after first sign-in). */
export const markUserNotNew = async (database: typeof DbType, id: string) =>
  database.update(user).set({ isNew: false }).where(eq(user.id, id))

const idleAnonymousUserBatchSize = 500

/**
 * `QueryableDatabase` narrowed to the driver-agnostic base: its pglite | postgres-js union
 * merges `returning`'s overloads, so a column list in `returning()` does not type-check on it.
 */
type PurgeDatabase = Pick<PgDatabase<PgQueryResultHKT, typeof schema>, 'delete' | 'select'>

/**
 * Hard-delete anonymous users idle for more than `idleDays` days, `batchSize` per statement until
 * none are left, so a first run on a large table never holds one long transaction. Deleting the
 * `user` row is the account-deletion path: sessions, devices, usage and E2EE rows cascade with it.
 *
 * A user counts as active while any of these is recent, each a timestamp the server writes itself:
 * - `user.updatedAt`, set at sign-in, so a user who never made a request is still dated;
 * - `session.updatedAt`, which Better Auth refreshes when a session in use is a day old;
 * - `inference_usage.createdAt`, one row per metered request.
 * A session that has not expired also keeps the user, so the purge never signs out a visitor whose
 * session outlives `idleDays`. Promoted users have `isAnonymous = false` and are never selected.
 * Resolves to the number of users deleted.
 */
export const deleteIdleAnonymousUsers = async (
  database: PurgeDatabase,
  idleDays: number,
  batchSize = idleAnonymousUserBatchSize,
) => {
  const now = new Date()
  const cutoff = new Date(now.getTime() - idleDays * 24 * 60 * 60 * 1000)
  const idleBatch = database
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.isAnonymous, true),
        lt(user.updatedAt, cutoff),
        notExists(
          database
            .select({ id: session.id })
            .from(session)
            .where(and(eq(session.userId, user.id), or(gte(session.updatedAt, cutoff), gt(session.expiresAt, now)))),
        ),
        notExists(
          database
            .select({ id: inferenceUsage.id })
            .from(inferenceUsage)
            .where(and(eq(inferenceUsage.userId, user.id), gte(inferenceUsage.createdAt, cutoff))),
        ),
      ),
    )
    .limit(batchSize)

  const deleteBatch = async (deletedSoFar: number): Promise<number> => {
    const deleted = await database.delete(user).where(inArray(user.id, idleBatch)).returning({ id: user.id })
    return deleted.length < batchSize ? deletedSoFar + deleted.length : deleteBatch(deletedSoFar + deleted.length)
  }
  return deleteBatch(0)
}
