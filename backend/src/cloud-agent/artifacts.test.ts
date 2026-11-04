/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../db/schema'
import { deleteUser } from '../dal/users'
import { and, eq } from 'drizzle-orm'
import { cloudArtifactScope } from '@shared/cloud-agent/contracts'
import {
  decryptScopedJson,
  encryptScopedJson,
  generateResourceIdentity,
  generateResourceKey,
  openResourceKey,
  sealResourceKey,
  type ResourceIdentity,
} from '@shared/cloud-agent/crypto'
import { user } from '../db/auth-schema'
import {
  cloudAgents,
  cloudArtifactGrants,
  cloudArtifactRevisions,
  cloudArtifacts,
  cloudBlobCleanup,
  cloudIdentities,
} from '../db/cloud-agent-schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '../test-utils/db'
import { createArtifactService, type ArtifactObjectStore } from './artifacts'

let testDb: IsolatedTestDb
let ownerIdentity: ResourceIdentity
let runtimeIdentity: ResourceIdentity
beforeAll(async () => {
  testDb = await getSharedIsolatedTestDb()
  ownerIdentity = await generateResourceIdentity()
  runtimeIdentity = await generateResourceIdentity()
}, 60_000)

/** Real scoped crypto and a memory object store exercise publication without network access. */
const fixture = async (database = testDb.db) => {
  const ownerId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const otherAgentId = crypto.randomUUID()
  await database
    .insert(user)
    .values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Artifact owner', emailVerified: true })
  await database
    .insert(cloudIdentities)
    .values({ userId: ownerId, publicKey: ownerIdentity.publicKey, privateRecord: {} })
  const key = await generateResourceKey()
  const cipher = await encryptScopedJson({}, key, {
    ownerId,
    scopeId: 'fixture',
    keyEpoch: 1,
    recordId: 'config',
    purpose: 'fixture',
  })
  const envelope = await sealResourceKey(key, ownerIdentity.publicKey, {
    ownerId,
    scopeId: 'fixture',
    keyEpoch: 1,
    recipientId: ownerId,
  })
  await database.insert(cloudAgents).values(
    [agentId, otherAgentId].map((id) => ({
      id,
      userId: ownerId,
      keyEpoch: 1,
      config: cipher,
      ownerKeyEnvelope: envelope,
      runtimeKeyEnvelope: envelope,
    })),
  )
  const bytes = new Map<string, Uint8Array>()
  const hooks: {
    beforePut?: () => Promise<void>
    afterGet?: () => Promise<void>
    failPut?: boolean
    failRemove?: boolean
  } = {}
  const objects: ArtifactObjectStore = {
    put: async (id, value) => {
      await hooks.beforePut?.()
      if (hooks.failPut) {
        throw new Error('Object upload failed')
      }
      bytes.set(id, Uint8Array.from(value))
    },
    get: async (id) => {
      const value = bytes.get(id)
      if (!value) {
        throw new Error('Object missing')
      }
      await hooks.afterGet?.()
      return Uint8Array.from(value)
    },
    remove: async (id) => {
      if (hooks.failRemove) {
        throw new Error('Object deletion failed')
      }
      bytes.delete(id)
    },
  }
  const clock = { date: new Date() }
  const service = createArtifactService({
    database: database,
    objects,
    runtimeIdentity,
    maxArtifactBytes: 1_000_000,
    maxStorageBytes: 100_000_000,
    now: () => clock.date,
  })
  const input = {
    artifactId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    title: 'Private report',
    mediaType: 'text/plain',
    files: [
      {
        path: 'report.txt',
        mediaType: 'text/plain',
        content: 'A private report produced while every device is offline.',
      },
    ],
  }
  const create = () => service.createFromRuntime(ownerId, agentId, input, ownerIdentity.publicKey)
  const ownerKey = async () => {
    const { artifact } = await service.get(ownerId, input.artifactId)
    return openResourceKey(
      artifact.ownerKeyEnvelope,
      ownerIdentity,
      { ownerId, scopeId: cloudArtifactScope(artifact.id), keyEpoch: artifact.keyEpoch, recipientId: ownerId },
      true,
    )
  }
  const grant = async (canWrite: boolean) => {
    const keyEnvelope = await sealResourceKey(await ownerKey(), runtimeIdentity.publicKey, {
      ownerId,
      scopeId: cloudArtifactScope(input.artifactId),
      keyEpoch: 1,
      recipientId: `agent:${otherAgentId}`,
    })
    await service.grantAgent(ownerId, input.artifactId, { agentId: otherAgentId, keyEpoch: 1, keyEnvelope, canWrite })
  }
  return {
    database,
    ownerId,
    agentId,
    otherAgentId,
    bytes,
    hooks,
    clock,
    service,
    input,
    create,
    ownerKey,
    grant,
    objects,
  }
}

describe('encrypted artifact publication', () => {
  it('uses the authenticated run recipient even if the database owner public key was substituted', async () => {
    const f = await fixture()
    const attacker = await generateResourceIdentity()
    await testDb.db
      .update(cloudIdentities)
      .set({ publicKey: attacker.publicKey })
      .where(eq(cloudIdentities.userId, f.ownerId))
    const saved = await f.create()
    expect(saved.artifact.ownerKeyEnvelope.recipientKeyId).toBe(ownerIdentity.publicKey.keyId)
    await expect(f.ownerKey()).resolves.toBeInstanceOf(CryptoKey)
    await expect(
      openResourceKey(saved.artifact.ownerKeyEnvelope, attacker, {
        ownerId: f.ownerId,
        scopeId: cloudArtifactScope(f.input.artifactId),
        keyEpoch: 1,
        recipientId: f.ownerId,
      }),
    ).rejects.toThrow()
  })

  it('uploads a complete encrypted snapshot before atomically exposing its metadata and recovery envelope', async () => {
    const f = await fixture()
    f.hooks.beforePut = async () => {
      expect(
        await testDb.db.select().from(cloudArtifacts).where(eq(cloudArtifacts.id, f.input.artifactId)),
      ).toHaveLength(0)
      expect(
        await testDb.db.select().from(cloudArtifactRevisions).where(eq(cloudArtifactRevisions.id, f.input.revisionId)),
      ).toHaveLength(0)
    }
    const saved = await f.create()
    expect(saved.artifact.currentRevisionId).toBe(f.input.revisionId)
    expect(saved.revisions).toHaveLength(1)
    expect(saved.revisions[0]?.conflict).toBe(false)
    const content = await f.service.content(f.ownerId, f.input.artifactId, f.input.revisionId)
    const plaintext = await decryptScopedJson(content.content, await f.ownerKey(), {
      ownerId: f.ownerId,
      scopeId: cloudArtifactScope(f.input.artifactId),
      keyEpoch: 1,
      recordId: f.input.revisionId,
      purpose: 'artifact-content',
    })
    expect(plaintext).toEqual({ files: f.input.files })
    expect(JSON.stringify(saved)).not.toContain(f.input.title)
    expect(new TextDecoder().decode([...f.bytes.values()][0])).not.toContain(f.input.files[0]!.content)
    const [row] = await testDb.db
      .select()
      .from(cloudArtifactRevisions)
      .where(eq(cloudArtifactRevisions.id, f.input.revisionId))
    expect(
      await testDb.db.select().from(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, row!.objectKey)),
    ).toHaveLength(0)
    expect((await f.service.readFromRuntime(f.ownerId, f.agentId, f.input.artifactId)).files).toEqual(f.input.files)
  })

  it('leaves failed uploads unpublished and queues their object keys for delayed cleanup', async () => {
    const f = await fixture()
    f.hooks.failPut = true
    await expect(f.create()).rejects.toThrow('Object upload failed')
    expect(await f.service.list(f.ownerId)).toHaveLength(0)
    expect(
      await testDb.db.select().from(cloudArtifactRevisions).where(eq(cloudArtifactRevisions.userId, f.ownerId)),
    ).toHaveLength(0)
  })

  it('preserves both full snapshots on stale-parent publication, and keeps the accepted head', async () => {
    const f = await fixture()
    await f.create()
    const next = {
      ...f.input,
      revisionId: crypto.randomUUID(),
      parentRevisionId: f.input.revisionId,
      files: [{ ...f.input.files[0]!, content: 'First change' }],
    }
    const accepted = await f.service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, next)
    const conflict = await f.service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
      ...next,
      revisionId: crypto.randomUUID(),
      files: [{ ...f.input.files[0]!, content: 'Concurrent change' }],
    })
    expect(accepted.conflict).toBe(false)
    expect(conflict.conflict).toBe(true)
    const state = await f.service.get(f.ownerId, f.input.artifactId)
    expect(state.artifact.currentRevisionId).toBe(accepted.id)
    expect(state.revisions).toHaveLength(3)
    expect(
      (await f.service.readFromRuntime(f.ownerId, f.agentId, f.input.artifactId, conflict.id)).files[0]?.content,
    ).toBe('Concurrent change')
    expect(
      (await f.service.readFromRuntime(f.ownerId, f.agentId, f.input.artifactId, f.input.revisionId)).files,
    ).toEqual(f.input.files)
  })

  it('makes exact retry identifiers idempotent while rejecting changed bodies', async () => {
    const f = await fixture()
    await f.create()
    await f.create()
    const next = { ...f.input, revisionId: crypto.randomUUID(), parentRevisionId: f.input.revisionId }
    const first = await f.service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, next)
    const second = await f.service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, next)
    expect(second).toEqual(first)
    await expect(
      f.service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, { ...next, title: 'Changed on retry' }),
    ).rejects.toThrow('different content')
    const opaque = await f.service.content(f.ownerId, f.input.artifactId, first.id)
    expect(await f.service.publish(f.ownerId, f.input.artifactId, { ...first, content: opaque.content })).toEqual(first)
    expect(f.bytes.size).toBe(2)
  })

  it('serializes concurrent creation and identical ciphertext publication retries', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<void>()
    const uploads = { count: 0 }
    f.hooks.beforePut = async () => {
      uploads.count += 1
      if (uploads.count === 2) {
        gate.resolve()
      }
      await gate.promise
    }
    const created = await Promise.all([f.create(), f.create()])
    expect(created[0]).toEqual(created[1])
    // This store permits overwrites: safety comes from distinct attempt keys, not conditional PUT.
    expect(f.bytes.size).toBe(2)
    f.hooks.beforePut = undefined
    const key = await f.ownerKey()
    const id = crypto.randomUUID()
    const context = { ownerId: f.ownerId, scopeId: cloudArtifactScope(f.input.artifactId), keyEpoch: 1, recordId: id }
    const input = {
      id,
      keyEpoch: 1,
      parentRevisionId: f.input.revisionId,
      content: await encryptScopedJson({ files: f.input.files }, key, { ...context, purpose: 'artifact-content' }),
      manifest: await encryptScopedJson({ title: 'Retry', mediaType: 'text/plain', files: [] }, key, {
        ...context,
        purpose: 'artifact-manifest',
      }),
    }
    const retryGate = Promise.withResolvers<void>()
    uploads.count = 0
    f.hooks.beforePut = async () => {
      uploads.count += 1
      if (uploads.count === 2) {
        retryGate.resolve()
      }
      await retryGate.promise
    }
    const results = await Promise.all([
      f.service.publish(f.ownerId, f.input.artifactId, input),
      f.service.publish(f.ownerId, f.input.artifactId, input),
    ])
    expect(results[0]).toEqual(results[1])
    expect(f.bytes.size).toBe(4)
    expect((await f.service.get(f.ownerId, f.input.artifactId)).revisions).toHaveLength(2)
  })

  it('rejects foreign parents and obsolete key epochs without changing the published head', async () => {
    const f = await fixture()
    await f.create()
    const original = await f.service.get(f.ownerId, f.input.artifactId)
    const content = await f.service.content(f.ownerId, f.input.artifactId, f.input.revisionId)
    const revision = { ...original.revisions[0]!, ...content, id: crypto.randomUUID() }
    await expect(
      f.service.publish(f.ownerId, f.input.artifactId, { ...revision, parentRevisionId: crypto.randomUUID() }),
    ).rejects.toThrow('revision not found')
    await expect(f.service.publish(f.ownerId, f.input.artifactId, { ...revision, keyEpoch: 2 })).rejects.toThrow(
      'key epoch changed',
    )
    expect((await f.service.get(f.ownerId, f.input.artifactId)).revisions).toHaveLength(1)
  })

  it('requires owner recovery identity before a cloud-created artifact can exist', async () => {
    const f = await fixture()
    await testDb.db.delete(cloudIdentities).where(eq(cloudIdentities.userId, f.ownerId))
    await expect(f.create()).rejects.toThrow('Owner recovery identity')
    expect(f.bytes.size).toBe(0)
  })
})

describe('artifact access boundaries', () => {
  it('lists authenticated manifests without reading the remote snapshot and respects revocation', async () => {
    const f = await fixture()
    await f.create()
    f.hooks.afterGet = async () => {
      throw new Error('Object storage should not be read')
    }
    const result = await f.service.manifestFromRuntime(f.ownerId, f.agentId, f.input.artifactId)
    expect(result.manifest.title).toBe(f.input.title)
    expect(result.revision.id).toBe(f.input.revisionId)
    await f.service.revokeGrant(f.ownerId, f.input.artifactId, f.agentId)
    await expect(f.service.manifestFromRuntime(f.ownerId, f.agentId, f.input.artifactId)).rejects.toThrow(
      'no active artifact grant',
    )
  })

  it('does not infer artifact access from account membership and distinguishes read from write grants', async () => {
    const f = await fixture()
    await f.create()
    await expect(f.service.readFromRuntime(f.ownerId, f.otherAgentId, f.input.artifactId)).rejects.toThrow(
      'no active artifact grant',
    )
    await f.grant(false)
    expect((await f.service.readFromRuntime(f.ownerId, f.otherAgentId, f.input.artifactId)).files).toEqual(
      f.input.files,
    )
    await expect(
      f.service.publishFromRuntime(f.ownerId, f.otherAgentId, f.input.artifactId, {
        ...f.input,
        revisionId: crypto.randomUUID(),
        parentRevisionId: f.input.revisionId,
      }),
    ).rejects.toThrow('no active artifact grant')
    await f.grant(true)
    const result = await f.service.publishFromRuntime(f.ownerId, f.otherAgentId, f.input.artifactId, {
      ...f.input,
      revisionId: crypto.randomUUID(),
      parentRevisionId: f.input.revisionId,
    })
    expect(result.conflict).toBe(false)
  })

  it('authenticates the exact assigned agent in its envelope', async () => {
    const f = await fixture()
    await f.create()
    const [grant] = await testDb.db
      .select()
      .from(cloudArtifactGrants)
      .where(
        and(eq(cloudArtifactGrants.artifactId, f.input.artifactId), eq(cloudArtifactGrants.recipientId, f.agentId)),
      )
    await expect(
      f.service.grantAgent(f.ownerId, f.input.artifactId, {
        agentId: f.otherAgentId,
        keyEpoch: 1,
        keyEnvelope: grant!.keyEnvelope,
        canWrite: false,
      }),
    ).rejects.toThrow()
  })

  it('rejects a correctly addressed envelope containing the wrong artifact key', async () => {
    const f = await fixture()
    await f.create()
    const keyEnvelope = await sealResourceKey(await generateResourceKey(), runtimeIdentity.publicKey, {
      ownerId: f.ownerId,
      scopeId: cloudArtifactScope(f.input.artifactId),
      keyEpoch: 1,
      recipientId: `agent:${f.otherAgentId}`,
    })
    await expect(
      f.service.grantAgent(f.ownerId, f.input.artifactId, {
        agentId: f.otherAgentId,
        keyEpoch: 1,
        keyEnvelope,
        canWrite: false,
      }),
    ).rejects.toThrow()
    await expect(f.service.readFromRuntime(f.ownerId, f.otherAgentId, f.input.artifactId)).rejects.toThrow(
      'no active artifact grant',
    )
  })

  it('rejects reads when a grant is revoked during object retrieval', async () => {
    const f = await fixture()
    await f.create()
    f.hooks.afterGet = () => f.service.revokeGrant(f.ownerId, f.input.artifactId, f.agentId)
    await expect(f.service.readFromRuntime(f.ownerId, f.agentId, f.input.artifactId)).rejects.toThrow(
      'no active artifact grant',
    )
    expect(await f.service.content(f.ownerId, f.input.artifactId, f.input.revisionId)).toHaveProperty('content')
  })

  it('rechecks authorization at publication after the upload completes', async () => {
    const f = await fixture()
    await f.create()
    f.hooks.beforePut = () => f.service.revokeGrant(f.ownerId, f.input.artifactId, f.agentId)
    await expect(
      f.service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
        ...f.input,
        revisionId: crypto.randomUUID(),
        parentRevisionId: f.input.revisionId,
      }),
    ).rejects.toThrow('no active artifact grant')
    expect((await f.service.get(f.ownerId, f.input.artifactId)).revisions).toHaveLength(1)
  })

  it('rejects another owner, a disabled agent, and deleted artifacts while retaining history', async () => {
    const f = await fixture()
    await f.create()
    await expect(f.service.get(crypto.randomUUID(), f.input.artifactId)).rejects.toThrow('Artifact not found')
    await expect(f.service.content(crypto.randomUUID(), f.input.artifactId, f.input.revisionId)).rejects.toThrow(
      'Artifact not found',
    )
    await testDb.db.update(cloudAgents).set({ enabled: false }).where(eq(cloudAgents.id, f.agentId))
    await expect(f.service.readFromRuntime(f.ownerId, f.agentId, f.input.artifactId)).rejects.toThrow(
      'Agent is not authorized',
    )
    await f.service.softDelete(f.ownerId, f.input.artifactId)
    expect(await f.service.list(f.ownerId)).toHaveLength(0)
    await expect(f.service.content(f.ownerId, f.input.artifactId, f.input.revisionId)).rejects.toThrow(
      'Artifact not found',
    )
    expect(
      await testDb.db
        .select()
        .from(cloudArtifactRevisions)
        .where(eq(cloudArtifactRevisions.artifactId, f.input.artifactId)),
    ).toHaveLength(1)
    expect(f.bytes.size).toBe(1)
  })

  it('detects substituted object bytes and manifest ciphertext from another record', async () => {
    const f = await fixture()
    await f.create()
    const [key, original] = [...f.bytes.entries()][0]!
    f.bytes.set(key, new Uint8Array([0, 1]))
    await expect(f.service.content(f.ownerId, f.input.artifactId, f.input.revisionId)).rejects.toThrow(
      'integrity check',
    )
    f.bytes.set(key, original)
    const other = await encryptScopedJson({}, await f.ownerKey(), {
      ownerId: f.ownerId,
      scopeId: cloudArtifactScope(f.input.artifactId),
      keyEpoch: 1,
      recordId: 'another-record',
      purpose: 'artifact-manifest',
    })
    await testDb.db
      .update(cloudArtifactRevisions)
      .set({ manifest: other })
      .where(eq(cloudArtifactRevisions.id, f.input.revisionId))
    await expect(f.service.readFromRuntime(f.ownerId, f.agentId, f.input.artifactId)).rejects.toThrow()
  })
})

describe('artifact retention and bounds', () => {
  it('collects abandoned uploads only after retention, and never collects a referenced historical revision', async () => {
    const f = await fixture()
    await f.create()
    const [saved] = await testDb.db
      .select()
      .from(cloudArtifactRevisions)
      .where(eq(cloudArtifactRevisions.id, f.input.revisionId))
    const orphan = `cloud-artifacts/${crypto.randomUUID()}`
    f.bytes.set(orphan, new Uint8Array([1]))
    await testDb.db.insert(cloudBlobCleanup).values([
      { objectKey: orphan, deleteAfter: new Date(f.clock.date.getTime() + 60_000).toISOString() },
      { objectKey: saved!.objectKey, deleteAfter: new Date(f.clock.date.getTime() + 60_000).toISOString() },
    ])
    await f.service.collectGarbage()
    expect(f.bytes.has(orphan)).toBe(true)
    f.clock.date = new Date(f.clock.date.getTime() + 60_001)
    await f.service.collectGarbage()
    expect(f.bytes.has(orphan)).toBe(false)
    expect(f.bytes.has(saved!.objectKey)).toBe(true)
    expect(await f.service.content(f.ownerId, f.input.artifactId, f.input.revisionId)).toHaveProperty('content')
  })

  it('retains cleanup work when object deletion fails', async () => {
    const f = await fixture()
    const orphan = `cloud-artifacts/${crypto.randomUUID()}`
    f.bytes.set(orphan, new Uint8Array([1]))
    await testDb.db
      .insert(cloudBlobCleanup)
      .values({ objectKey: orphan, deleteAfter: new Date(f.clock.date.getTime() - 1).toISOString() })
    f.hooks.failRemove = true
    await expect(f.service.collectGarbage()).rejects.toThrow('Object deletion failed')
    expect(await testDb.db.select().from(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, orphan))).toHaveLength(
      1,
    )
    expect(f.bytes.has(orphan)).toBe(true)
    f.hooks.failRemove = false
    await f.service.collectGarbage()
  })

  it('rejects oversized snapshots and paths unsafe to materialize', async () => {
    const f = await fixture()
    const tiny = createArtifactService({
      database: testDb.db,
      objects: f.objects,
      runtimeIdentity,
      maxArtifactBytes: 10,
      maxStorageBytes: 100_000_000,
    })
    await expect(tiny.createFromRuntime(f.ownerId, f.agentId, f.input, ownerIdentity.publicKey)).rejects.toThrow(
      'too large',
    )
    for (const path of ['/absolute', '../escape', 'a/../escape', 'a\\escape', 'same//path']) {
      await expect(
        f.service.createFromRuntime(
          f.ownerId,
          f.agentId,
          { ...f.input, files: [{ ...f.input.files[0]!, path }] },
          ownerIdentity.publicKey,
        ),
      ).rejects.toThrow('relative paths')
    }
    await expect(
      f.service.createFromRuntime(
        f.ownerId,
        f.agentId,
        { ...f.input, files: [f.input.files[0]!, f.input.files[0]!] },
        ownerIdentity.publicKey,
      ),
    ).rejects.toThrow('relative paths')
    expect(f.bytes.size).toBe(0)
  })
})

describe('committed artifact storage quota', () => {
  const limited = (f: Awaited<ReturnType<typeof fixture>>, bytes: number) =>
    createArtifactService({
      database: testDb.db,
      objects: f.objects,
      runtimeIdentity,
      maxArtifactBytes: 1_000_000,
      maxStorageBytes: bytes,
      now: () => f.clock.date,
    })

  it('counts conflicting revisions, accepts exact retries at the limit, and cleans rejected uploads later', async () => {
    const f = await fixture()
    const first = await f.create()
    const service = limited(f, first.revisions[0]!.byteLength * 2)
    const input = { ...f.input, revisionId: crypto.randomUUID(), parentRevisionId: null }
    const second = await service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, input)
    expect(second.conflict).toBe(true)
    expect(await service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, input)).toEqual(second)
    expect(f.bytes.size).toBe(2)
    await expect(
      service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
        ...input,
        revisionId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 413, code: 'artifact_storage_quota_exceeded' })
    expect((await service.get(f.ownerId, f.input.artifactId)).revisions).toHaveLength(2)
    expect(f.bytes.size).toBe(3)
    f.clock.date = new Date(f.clock.date.getTime() + 25 * 60 * 60 * 1000)
    await service.collectGarbage()
    expect(f.bytes.size).toBe(2)
  })

  it('prevents concurrent revisions from exceeding the owner total and rejects new artifacts at capacity', async () => {
    const f = await fixture()
    const first = await f.create()
    const service = limited(f, first.revisions[0]!.byteLength * 2)
    const input = { ...f.input, parentRevisionId: f.input.revisionId }
    const results = await Promise.allSettled([
      service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
        ...input,
        revisionId: crypto.randomUUID(),
      }),
      service.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
        ...input,
        revisionId: crypto.randomUUID(),
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'artifact_storage_quota_exceeded' },
    })
    const other = { ...f.input, artifactId: crypto.randomUUID(), revisionId: crypto.randomUUID() }
    await expect(service.createFromRuntime(f.ownerId, f.agentId, other, ownerIdentity.publicKey)).rejects.toMatchObject(
      { code: 'artifact_storage_quota_exceeded' },
    )
    expect(await testDb.db.select().from(cloudArtifacts).where(eq(cloudArtifacts.id, other.artifactId))).toHaveLength(0)
    expect((await service.get(f.ownerId, f.input.artifactId)).revisions).toHaveLength(2)
  })
})

const realPostgresSuite = process.env.CLOUD_AGENT_TEST_DATABASE_URL ? describe : describe.skip
realPostgresSuite('artifact quota concurrency on Postgres', () => {
  const client = postgres(process.env.CLOUD_AGENT_TEST_DATABASE_URL!, { max: 4 })
  afterAll(() => client.end())
  it('serializes independent writer transactions on the owner budget lock', async () => {
    const database = drizzle(client, { schema })
    const f = await fixture(database)
    try {
      const first = await f.create()
      const limited = createArtifactService({
        database,
        objects: f.objects,
        runtimeIdentity,
        maxArtifactBytes: 1_000_000,
        maxStorageBytes: first.revisions[0]!.byteLength * 2,
      })
      const input = { ...f.input, parentRevisionId: f.input.revisionId }
      const gate = Promise.withResolvers<void>()
      const state = { uploads: 0 }
      f.hooks.beforePut = async () => {
        state.uploads += 1
        if (state.uploads === 2) {
          gate.resolve()
        }
        await gate.promise
      }
      const results = await Promise.allSettled([
        limited.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
          ...input,
          revisionId: crypto.randomUUID(),
        }),
        limited.publishFromRuntime(f.ownerId, f.agentId, f.input.artifactId, {
          ...input,
          revisionId: crypto.randomUUID(),
        }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'artifact_storage_quota_exceeded' },
      })
      expect((await limited.get(f.ownerId, f.input.artifactId)).revisions).toHaveLength(2)
    } finally {
      await deleteUser(database, f.ownerId)
    }
  })
})
