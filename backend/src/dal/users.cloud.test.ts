/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { ResourceKeyEnvelope, ScopedCiphertext } from '@shared/cloud-agent/crypto'
import { user } from '../db/auth-schema'
import {
  cloudAgents,
  cloudArtifactGrants,
  cloudArtifactRevisions,
  cloudArtifacts,
  cloudBlobCleanup,
  cloudConnectionOAuth,
  cloudConnections,
} from '../db/cloud-agent-schema'
import { cloudRuntimeNamespaces, cloudRuntimeRecords } from '../db/cloud-runtime-schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '../test-utils/db'
import { deleteIdleAnonymousUsers, deleteUser } from './users'

let testDb: IsolatedTestDb
beforeAll(async () => {
  testDb = await getSharedIsolatedTestDb()
}, 60_000)
const content: ScopedCiphertext = {
  version: 1,
  kind: 'scoped-payload',
  iv: 'opaque-iv',
  ciphertext: 'opaque-ciphertext',
}
const envelope: ResourceKeyEnvelope = {
  version: 1,
  kind: 'resource-key',
  recipientKeyId: 'opaque-recipient',
  ephemeralPublicKey: 'opaque-public-key',
  mlkemCiphertext: 'opaque-kem',
  iv: 'opaque-iv',
  ciphertext: 'opaque-ciphertext',
}

/** Distinct owners prove account cleanup cannot consume another owner's artifact or runtime state. */
const seed = async (anonymous = false) => {
  const ownerId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const artifactId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const connectionId = crypto.randomUUID()
  const objectKey = `cloud-artifacts/${crypto.randomUUID()}`
  const updatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  await testDb.db.insert(user).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
    name: 'Cloud owner',
    isAnonymous: anonymous,
    createdAt: updatedAt,
    updatedAt,
  })
  await testDb.db.insert(cloudAgents).values({
    id: agentId,
    userId: ownerId,
    keyEpoch: 1,
    config: content,
    ownerKeyEnvelope: envelope,
    runtimeKeyEnvelope: envelope,
  })
  await testDb.db
    .insert(cloudArtifacts)
    .values({ id: artifactId, userId: ownerId, keyEpoch: 1, currentRevisionId: revisionId, ownerKeyEnvelope: envelope })
  await testDb.db.insert(cloudArtifactRevisions).values({
    id: revisionId,
    artifactId,
    userId: ownerId,
    keyEpoch: 1,
    manifest: content,
    objectKey,
    digest: 'opaque-digest',
    byteLength: 100,
  })
  await testDb.db.insert(cloudArtifactGrants).values({
    artifactId,
    recipientId: agentId,
    recipientKind: 'agent',
    keyEpoch: 1,
    keyEnvelope: envelope,
    canWrite: true,
  })
  await testDb.db.insert(cloudRuntimeNamespaces).values({ namespace: `agent:${agentId}` })
  await testDb.db.insert(cloudRuntimeRecords).values({
    namespace: `agent:${agentId}`,
    id: 1,
    recordType: 'conversation',
    commitSeq: 1,
    payload: 'opaque-payload',
  })
  await testDb.db.insert(cloudConnections).values({
    id: connectionId,
    userId: ownerId,
    keyEpoch: 1,
    config: content,
    ownerKeyEnvelope: envelope,
    runtimeKeyEnvelope: envelope,
  })
  await testDb.db.insert(cloudConnectionOAuth).values({
    connectionId,
    userId: ownerId,
    stateDigest: crypto.randomUUID(),
    connectionVersion: 1,
    keyEpoch: 1,
    payload: content,
    expiresAt: new Date().toISOString(),
  })
  return { ownerId, agentId, artifactId, revisionId, connectionId, objectKey }
}

describe('cloud account deletion', () => {
  it('queues encrypted objects and removes grants, OAuth attempts and runtime records in the account transaction', async () => {
    const owner = await seed()
    const neighbor = await seed()
    await testDb.db.insert(cloudArtifactGrants).values({
      artifactId: neighbor.artifactId,
      recipientId: owner.agentId,
      recipientKind: 'agent',
      keyEpoch: 1,
      keyEnvelope: envelope,
    })
    await deleteUser(testDb.db, owner.ownerId)
    expect(await testDb.db.select().from(user).where(eq(user.id, owner.ownerId))).toHaveLength(0)
    expect(await testDb.db.select().from(cloudArtifacts).where(eq(cloudArtifacts.id, owner.artifactId))).toHaveLength(0)
    expect(
      await testDb.db.select().from(cloudArtifactRevisions).where(eq(cloudArtifactRevisions.id, owner.revisionId)),
    ).toHaveLength(0)
    expect(
      await testDb.db.select().from(cloudArtifactGrants).where(eq(cloudArtifactGrants.recipientId, owner.agentId)),
    ).toHaveLength(0)
    expect(
      await testDb.db
        .select()
        .from(cloudConnectionOAuth)
        .where(eq(cloudConnectionOAuth.connectionId, owner.connectionId)),
    ).toHaveLength(0)
    expect(
      await testDb.db
        .select()
        .from(cloudRuntimeRecords)
        .where(eq(cloudRuntimeRecords.namespace, `agent:${owner.agentId}`)),
    ).toHaveLength(0)
    const queued = await testDb.db
      .select()
      .from(cloudBlobCleanup)
      .where(eq(cloudBlobCleanup.objectKey, owner.objectKey))
    expect(queued).toHaveLength(1)
    expect(Date.parse(queued[0]!.deleteAfter)).toBeGreaterThan(Date.now())
    expect(
      await testDb.db.select().from(cloudArtifacts).where(eq(cloudArtifacts.id, neighbor.artifactId)),
    ).toHaveLength(1)
    expect(
      await testDb.db.select().from(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, neighbor.objectKey)),
    ).toHaveLength(0)
    expect(
      await testDb.db
        .select()
        .from(cloudRuntimeRecords)
        .where(eq(cloudRuntimeRecords.namespace, `agent:${neighbor.agentId}`)),
    ).toHaveLength(1)
  })

  it('rolls back object cleanup and grant removal if account deletion cannot commit', async () => {
    const owner = await seed()
    await testDb.db.execute(
      sql`CREATE TABLE IF NOT EXISTS account_cleanup_blocker (user_id text REFERENCES "user"(id))`,
    )
    await testDb.db.execute(sql`INSERT INTO account_cleanup_blocker(user_id) VALUES (${owner.ownerId})`)
    await expect(deleteUser(testDb.db, owner.ownerId)).rejects.toThrow()
    expect(
      await testDb.db.select().from(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, owner.objectKey)),
    ).toHaveLength(0)
    expect(
      await testDb.db.select().from(cloudArtifactGrants).where(eq(cloudArtifactGrants.artifactId, owner.artifactId)),
    ).toHaveLength(1)
    expect(
      await testDb.db
        .select()
        .from(cloudRuntimeRecords)
        .where(eq(cloudRuntimeRecords.namespace, `agent:${owner.agentId}`)),
    ).toHaveLength(1)
    await testDb.db.execute(sql`DELETE FROM account_cleanup_blocker WHERE user_id = ${owner.ownerId}`)
  })

  it('uses the same cleanup transaction for idle anonymous accounts', async () => {
    const owner = await seed(true)
    expect(await deleteIdleAnonymousUsers(testDb.db, 30)).toBeGreaterThanOrEqual(1)
    expect(await testDb.db.select().from(user).where(eq(user.id, owner.ownerId))).toHaveLength(0)
    expect(
      await testDb.db.select().from(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, owner.objectKey)),
    ).toHaveLength(1)
  })
})
