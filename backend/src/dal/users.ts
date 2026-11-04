/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import { session, user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { and, eq, gt, gte, inArray, lt, notExists, or } from 'drizzle-orm'
import {
  cloudAgents,
  cloudArtifactGrants,
  cloudArtifactRevisions,
  cloudArtifacts,
  cloudBlobCleanup,
  cloudIdentities,
} from '@/db/cloud-agent-schema'
import { cloudRuntimeNamespaces } from '@/db/cloud-runtime-schema'

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

/** Remove non-cascading grants and runtime scopes, queuing encrypted objects before their references disappear. */
const removeCloudAccountData = async (database: QueryableDatabase, ids: string[]) => {
  if (ids.length === 0) {
    return
  }
  // Match creation/publication lock order before the user cascade reaches the owner identity.
  await database
    .select({ id: cloudIdentities.userId })
    .from(cloudIdentities)
    .where(inArray(cloudIdentities.userId, ids))
    .for('update')
  const agents = await database
    .select({ id: cloudAgents.id })
    .from(cloudAgents)
    .where(inArray(cloudAgents.userId, ids))
    .for('update')
  const artifacts = await database
    .select({ id: cloudArtifacts.id })
    .from(cloudArtifacts)
    .where(inArray(cloudArtifacts.userId, ids))
    .for('update')
  const revisions = await database
    .select({ objectKey: cloudArtifactRevisions.objectKey })
    .from(cloudArtifactRevisions)
    .where(inArray(cloudArtifactRevisions.userId, ids))
  if (revisions.length) {
    await database
      .insert(cloudBlobCleanup)
      .values(
        revisions.map(({ objectKey }) => ({
          objectKey,
          deleteAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })),
      )
      .onConflictDoNothing()
  }
  if (artifacts.length) {
    await database.delete(cloudArtifactGrants).where(
      inArray(
        cloudArtifactGrants.artifactId,
        artifacts.map(({ id }) => id),
      ),
    )
  }
  if (agents.length) {
    await database.delete(cloudArtifactGrants).where(
      and(
        eq(cloudArtifactGrants.recipientKind, 'agent'),
        inArray(
          cloudArtifactGrants.recipientId,
          agents.map(({ id }) => id),
        ),
      ),
    )
    await database.delete(cloudRuntimeNamespaces).where(
      inArray(
        cloudRuntimeNamespaces.namespace,
        agents.map(({ id }) => `agent:${id}`),
      ),
    )
  }
}

/** Account removal is atomic with durable object cleanup; remaining owned rows cascade with the user. */
export const deleteUser = async (database: typeof DbType, id: string) =>
  database.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for('update')
    await removeCloudAccountData(tx, [id])
    return tx.delete(user).where(eq(user.id, id))
  })

/** Mark a user as no longer new (after first sign-in). */
export const markUserNotNew = async (database: typeof DbType, id: string) =>
  database.update(user).set({ isNew: false }).where(eq(user.id, id))

const idleAnonymousUserBatchSize = 500

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
  database: typeof DbType,
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
    const deleted = await database.transaction(async (tx) => {
      const candidates = await tx.select({ id: user.id }).from(user).where(inArray(user.id, idleBatch)).for('update')
      if (candidates.length === 0) {
        return []
      }
      const ids = candidates.map(({ id }) => id)
      await removeCloudAccountData(tx, ids)
      return tx.delete(user).where(inArray(user.id, ids)).returning()
    })
    return deleted.length < batchSize ? deletedSoFar + deleted.length : deleteBatch(deletedSoFar + deleted.length)
  }
  return deleteBatch(0)
}
