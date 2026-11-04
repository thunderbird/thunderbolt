/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { gte, sql } from 'drizzle-orm'
import {
  cloudAgentProjections,
  cloudAgents,
  cloudApprovals,
  cloudArtifactRevisions,
  cloudArtifacts,
  cloudConnections,
  cloudConversations,
  cloudIdentities,
  cloudMessages,
  cloudRuns,
  cloudSchedules,
} from '@/db/cloud-agent-schema'
import type { CloudDatabase } from './service'

type Projection = typeof cloudAgentProjections.$inferInsert
const projection = (
  kind: string,
  id: string,
  userId: string,
  payload: unknown,
  updatedAt: string,
  parentId: string | null = null,
  deletedAt: string | null = null,
): Projection => ({
  id: `${kind}:${id}`,
  kind,
  userId,
  parentId,
  payload: JSON.stringify(payload),
  updatedAt,
  deletedAt,
})

/** Rebuildable server-owned projections contain only the same encrypted fields the API exposes. */
export const projectCloudChanges = async (database: CloudDatabase, since: string, authoritative = false) => {
  const rows: Projection[] = []
  for (const row of await database.select().from(cloudIdentities).where(gte(cloudIdentities.createdAt, since))) {
    rows.push(projection('identity', row.userId, row.userId, { identity: row.privateRecord }, row.createdAt))
  }
  for (const { runtimeKeyEnvelope: _runtime, saveDigest: _saveDigest, userId, ...record } of await database
    .select()
    .from(cloudAgents)
    .where(gte(cloudAgents.updatedAt, since))) {
    rows.push(
      projection('agent', record.id, userId, { ...record, ownerId: userId }, record.updatedAt, null, record.deletedAt),
    )
  }
  for (const {
    runtimeKeyEnvelope: _runtime,
    saveDigest: _saveDigest,
    credentialVersion: _credentialVersion,
    createdAt: _created,
    userId,
    ...record
  } of await database.select().from(cloudConnections).where(gte(cloudConnections.updatedAt, since))) {
    rows.push(
      projection(
        'connection',
        record.id,
        userId,
        { ...record, ownerId: userId },
        record.updatedAt,
        null,
        record.deletedAt,
      ),
    )
  }
  for (const { piConversationId: _pi, userId, ...record } of await database
    .select()
    .from(cloudConversations)
    .where(gte(cloudConversations.updatedAt, since))) {
    rows.push(
      projection(
        'conversation',
        record.id,
        userId,
        { ...record, ownerId: userId },
        record.updatedAt,
        record.agentId,
        record.deletedAt,
      ),
    )
  }
  for (const row of await database.select().from(cloudRuns).where(gte(cloudRuns.updatedAt, since))) {
    const { id, conversationId, commandId, configVersion, status, errorCode, createdAt, updatedAt } = row
    rows.push(
      projection(
        'run',
        id,
        row.userId,
        { id, conversationId, commandId, configVersion, status, errorCode, createdAt, updatedAt },
        updatedAt,
        conversationId,
      ),
    )
  }
  for (const { userId, ...record } of await database
    .select()
    .from(cloudMessages)
    .where(gte(cloudMessages.createdAt, since))) {
    rows.push(projection('message', record.id, userId, record, record.createdAt, record.conversationId))
  }
  for (const row of await database
    .select({ approval: cloudApprovals, conversationId: cloudRuns.conversationId })
    .from(cloudApprovals)
    .innerJoin(cloudRuns, sql`${cloudApprovals.runId} = ${cloudRuns.id}`)
    .where(gte(cloudApprovals.updatedAt, since))) {
    const { userId, callId: _call, argumentDigest: _digest, updatedAt, ...record } = row.approval
    rows.push(projection('approval', record.id, userId, record, updatedAt, row.conversationId))
  }
  for (const { userId, saveDigest: _saveDigest, activeRunId: _run, ...record } of await database
    .select()
    .from(cloudSchedules)
    .where(gte(cloudSchedules.updatedAt, since))) {
    rows.push(projection('schedule', record.id, userId, record, record.updatedAt, record.agentId))
  }
  // Artifact pointers change with revisions. Their table intentionally has no mutable payload.
  for (const { userId, ...record } of await database.select().from(cloudArtifacts)) {
    rows.push(
      projection(
        'artifact',
        record.id,
        userId,
        { ...record, ownerId: userId },
        new Date().toISOString(),
        null,
        record.deletedAt,
      ),
    )
  }
  for (const { userId, objectKey: _object, digest: _digest, ...record } of await database
    .select()
    .from(cloudArtifactRevisions)
    .where(gte(cloudArtifactRevisions.createdAt, since))) {
    rows.push(projection('revision', record.id, userId, record, record.createdAt, record.artifactId))
  }
  for (const row of rows) {
    await database
      .insert(cloudAgentProjections)
      .values(row)
      .onConflictDoUpdate({
        target: cloudAgentProjections.id,
        set: { payload: row.payload, parentId: row.parentId, updatedAt: row.updatedAt, deletedAt: row.deletedAt },
        setWhere: authoritative
          ? sql`${cloudAgentProjections.payload} IS DISTINCT FROM ${row.payload}`
          : sql`${cloudAgentProjections.updatedAt} <= ${row.updatedAt} AND ${cloudAgentProjections.payload} IS DISTINCT FROM ${row.payload}`,
      })
  }
}
