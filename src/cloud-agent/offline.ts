/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import {
  cloudAgentCacheTable as cache,
  cloudAgentOutboxTable as outbox,
  cloudAgentProjectionsTable as projections,
} from '@/db/tables'
import { reconstructCloudRead } from './projections'

export type CloudOutboxEntry = typeof outbox.$inferSelect
export type CloudOutboxCommand = {
  id: string
  kind: 'message' | 'agent-save'
  resourceId: string
  endpoint: string
  payload: string
}

/** Persist ciphertext only. Server projections are never mutated by this store. */
export const createCloudOfflineStore = (db: AnyDrizzleDatabase, ownerId: string) => {
  const owned = eq(outbox.userId, ownerId)
  const active = and(owned, isNull(outbox.deletedAt))
  const entries = () => db.select().from(outbox).where(active).orderBy(asc(outbox.createdAt))
  return {
    entries,
    read: async <T>(resource: string): Promise<T | undefined> => {
      const [snapshots, rows] = await Promise.all([
        db
          .select()
          .from(cache)
          .where(and(eq(cache.userId, ownerId), eq(cache.resourceKey, resource)))
          .limit(1),
        db.select().from(projections).where(eq(projections.userId, ownerId)),
      ])
      const cached: unknown = snapshots[0] ? JSON.parse(snapshots[0].payload) : undefined
      // An empty first sync is not proof that an owner's server collection is empty.
      if (cached === undefined && rows.length === 0) {
        return undefined
      }
      return reconstructCloudRead(resource, rows, cached) as T | undefined
    },
    cache: async (resource: string, value: unknown) => {
      const record = {
        id: `${ownerId}:${resource}`,
        userId: ownerId,
        resourceKey: resource,
        payload: JSON.stringify(value),
        updatedAt: new Date().toISOString(),
      }
      await db.transaction(async (tx) => {
        const existing = await tx.select({ id: cache.id }).from(cache).where(eq(cache.id, record.id)).get()
        if (existing) {
          await tx.update(cache).set(record).where(eq(cache.id, record.id))
        } else {
          await tx.insert(cache).values(record)
        }
      })
    },
    enqueue: async (command: CloudOutboxCommand) => {
      // SQLite serializes the write transaction across tabs. Plain INSERT/UPDATE
      // works with PowerSync's views; ON CONFLICT does not.
      return db.transaction(async (tx) => {
        const stored = await tx.select().from(outbox).where(eq(outbox.id, command.id)).get()
        if (stored) {
          if (stored.userId !== ownerId || stored.payload !== command.payload || stored.endpoint !== command.endpoint) {
            throw new Error('Cloud command ID already has different content')
          }
          return stored
        }
        await tx.insert(outbox).values({
          ...command,
          userId: ownerId,
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
        const inserted = await tx.select().from(outbox).where(eq(outbox.id, command.id)).get()
        if (!inserted) {
          throw new Error('Cloud command was not persisted')
        }
        return inserted
      })
    },
    settle: async (id: string) => {
      await db
        .update(outbox)
        .set({ status: 'sent', deletedAt: new Date().toISOString(), errorCode: null })
        .where(and(owned, eq(outbox.id, id)))
    },
    fail: async (id: string, errorCode: string) => {
      await db
        .update(outbox)
        .set({ status: 'needs-review', errorCode })
        .where(and(active, eq(outbox.id, id)))
    },
    discard: async (id: string) => {
      await db
        .update(outbox)
        .set({ status: 'discarded', deletedAt: new Date().toISOString() })
        .where(and(active, eq(outbox.id, id)))
    },
  }
}
export type CloudOfflineStore = ReturnType<typeof createCloudOfflineStore>
