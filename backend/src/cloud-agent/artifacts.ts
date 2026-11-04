/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  cloudArtifactScope,
  type ArtifactManifest,
  type CloudArtifact,
  type CloudArtifactRevision,
  type CloudArtifactState,
} from '@shared/cloud-agent/contracts'
import {
  decryptScopedJson,
  encryptScopedJson,
  generateResourceKey,
  openResourceKey,
  sealResourceKey,
  type ResourceIdentity,
  type ResourcePublicKey,
  type ResourceKeyEnvelope,
  type ScopedCiphertext,
} from '@shared/cloud-agent/crypto'
import type { db as DbType, QueryableDatabase } from '../db/client'
import {
  cloudAgents,
  cloudArtifactGrants,
  cloudArtifactRevisions,
  cloudArtifacts,
  cloudBlobCleanup,
  cloudIdentities,
} from '../db/cloud-agent-schema'
import { ciphertextSchema } from './input'
import type { ArtifactObjectStore } from './artifacts/object-store'

export { createS3ArtifactObjectStore, type ArtifactObjectStore } from './artifacts/object-store'

export type ArtifactFile = { path: string; mediaType: string; content: string }
export type ArtifactSnapshot = { title: string; mediaType: string; files: ArtifactFile[] }
export type PublishArtifactRevision = {
  id: string
  parentRevisionId: string | null
  keyEpoch: number
  manifest: ScopedCiphertext
  content: ScopedCiphertext
}
export type ArtifactCrypto = {
  generateKey: typeof generateResourceKey
  sealKey: typeof sealResourceKey
  openKey: typeof openResourceKey
  encrypt: typeof encryptScopedJson
  decrypt: typeof decryptScopedJson
}
const defaultCrypto: ArtifactCrypto = {
  generateKey: generateResourceKey,
  sealKey: sealResourceKey,
  openKey: openResourceKey,
  encrypt: encryptScopedJson,
  decrypt: decryptScopedJson,
}
export type ArtifactServiceOptions = {
  database: typeof DbType
  objects: ArtifactObjectStore
  runtimeIdentity: ResourceIdentity
  maxArtifactBytes: number
  maxStorageBytes: number
  cryptography?: ArtifactCrypto
  now?: () => Date
}

/** Domain errors preserve the distinction between authorization, stale publication and storage failure. */
export class ArtifactServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 413 | 503,
    message: string,
    readonly code = 'artifact_request_failed',
  ) {
    super(message)
  }
}

const encoder = new TextEncoder()
const snapshotSchema = z.strictObject({
  files: z
    .array(z.strictObject({ path: z.string().min(1), mediaType: z.string().min(1), content: z.string() }))
    .min(1)
    .max(1000),
})
const manifestSchema = z.strictObject({
  title: z.string(),
  mediaType: z.string().min(1),
  files: z
    .array(
      z.strictObject({ path: z.string().min(1), mediaType: z.string().min(1), size: z.number().int().nonnegative() }),
    )
    .min(1)
    .max(1000),
})
const retentionMs = 24 * 60 * 60 * 1000

/** Keep scope derivation identical for client reads and offline cloud production. */
const payloadContext = (
  ownerId: string,
  artifactId: string,
  keyEpoch: number,
  revisionId: string,
  purpose: string,
) => ({ ownerId, scopeId: cloudArtifactScope(artifactId), keyEpoch, recordId: revisionId, purpose })
/** A shared runtime key is cryptographically bound to each separately authorized agent grant. */
const grantContext = (ownerId: string, artifactId: string, keyEpoch: number, agentId: string) => ({
  ownerId,
  scopeId: cloudArtifactScope(artifactId),
  keyEpoch,
  recipientId: `agent:${agentId}`,
})
/** Return public revision metadata without exposing object-store addressing or internal digests. */
const revisionRecord = (row: typeof cloudArtifactRevisions.$inferSelect): CloudArtifactRevision => ({
  id: row.id,
  artifactId: row.artifactId,
  parentRevisionId: row.parentRevisionId,
  keyEpoch: row.keyEpoch,
  manifest: row.manifest,
  byteLength: row.byteLength,
  conflict: row.conflict,
  createdAt: row.createdAt,
})
/** Map database ownership to the public resource contract. */
const artifactRecord = (row: typeof cloudArtifacts.$inferSelect): CloudArtifact => ({
  id: row.id,
  ownerId: row.userId,
  currentRevisionId: row.currentRevisionId,
  keyEpoch: row.keyEpoch,
  ownerKeyEnvelope: row.ownerKeyEnvelope,
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
})
/** Hash ciphertext to detect object substitution before returning opaque bytes to clients. */
const digestBytes = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))).toString('hex')
/** Snapshot paths remain relative and unique, including when a bundle is later materialized on disk. */
const validateFiles = (files: ArtifactFile[]): void => {
  snapshotSchema.parse({ files })
  const paths = new Set<string>()
  for (const file of files) {
    if (
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path)
    ) {
      throw new ArtifactServiceError(409, 'Artifact file paths must be unique relative paths')
    }
    paths.add(file.path)
  }
}

/** Encrypted object publication and authoritative authorization live together at this service boundary. */
export const createArtifactService = ({
  database,
  objects,
  runtimeIdentity,
  maxArtifactBytes,
  maxStorageBytes,
  cryptography = defaultCrypto,
  now = () => new Date(),
}: ArtifactServiceOptions) => {
  const lockOwner = async (tx: QueryableDatabase, ownerId: string) => {
    const [owner] = await tx
      .select({ id: cloudIdentities.userId })
      .from(cloudIdentities)
      .where(eq(cloudIdentities.userId, ownerId))
      .for('update')
    if (!owner) {
      throw new ArtifactServiceError(409, 'Owner recovery identity is required')
    }
  }
  const checkStorageQuota = async (tx: QueryableDatabase, ownerId: string, additionalBytes: number) => {
    const [usage] = await tx
      .select({ bytes: sql<string>`coalesce(sum(${cloudArtifactRevisions.byteLength}), 0)` })
      .from(cloudArtifactRevisions)
      .where(eq(cloudArtifactRevisions.userId, ownerId))
    if (Number(usage.bytes) + additionalBytes > maxStorageBytes) {
      throw new ArtifactServiceError(413, 'Artifact storage limit reached', 'artifact_storage_quota_exceeded')
    }
  }
  const ownedArtifact = async (db: QueryableDatabase, ownerId: string, artifactId: string, lock = false) => {
    const query = db
      .select()
      .from(cloudArtifacts)
      .where(
        and(eq(cloudArtifacts.id, artifactId), eq(cloudArtifacts.userId, ownerId), isNull(cloudArtifacts.deletedAt)),
      )
    const [row] = await (lock ? query.for('update') : query)
    if (!row) {
      throw new ArtifactServiceError(404, 'Artifact not found')
    }
    return row
  }
  const activeAgent = async (db: QueryableDatabase, ownerId: string, agentId: string, lock = false) => {
    const query = db
      .select({ id: cloudAgents.id })
      .from(cloudAgents)
      .where(
        and(
          eq(cloudAgents.id, agentId),
          eq(cloudAgents.userId, ownerId),
          eq(cloudAgents.enabled, true),
          isNull(cloudAgents.deletedAt),
        ),
      )
    const [agent] = await (lock ? query.for('update') : query)
    if (!agent) {
      throw new ArtifactServiceError(403, 'Agent is not authorized')
    }
  }
  const agentGrant = async (
    db: QueryableDatabase,
    ownerId: string,
    agentId: string,
    artifactId: string,
    write: boolean,
    lock = false,
  ) => {
    await activeAgent(db, ownerId, agentId, lock)
    const artifact = await ownedArtifact(db, ownerId, artifactId, lock)
    const query = db
      .select()
      .from(cloudArtifactGrants)
      .where(
        and(
          eq(cloudArtifactGrants.artifactId, artifactId),
          eq(cloudArtifactGrants.recipientId, agentId),
          eq(cloudArtifactGrants.recipientKind, 'agent'),
          eq(cloudArtifactGrants.keyEpoch, artifact.keyEpoch),
          isNull(cloudArtifactGrants.revokedAt),
        ),
      )
    const [grant] = await (lock ? query.for('update') : query)
    if (!grant || (write && !grant.canWrite)) {
      throw new ArtifactServiceError(403, 'Agent has no active artifact grant')
    }
    return { artifact, grant }
  }
  const findRevision = async (db: QueryableDatabase, ownerId: string, artifactId: string, revisionId: string) => {
    const [row] = await db
      .select()
      .from(cloudArtifactRevisions)
      .where(
        and(
          eq(cloudArtifactRevisions.id, revisionId),
          eq(cloudArtifactRevisions.artifactId, artifactId),
          eq(cloudArtifactRevisions.userId, ownerId),
        ),
      )
    if (!row) {
      throw new ArtifactServiceError(404, 'Artifact revision not found')
    }
    return row
  }
  const get = async (ownerId: string, artifactId: string): Promise<CloudArtifactState> => {
    const artifact = await ownedArtifact(database, ownerId, artifactId)
    const revisions = await database
      .select()
      .from(cloudArtifactRevisions)
      .where(and(eq(cloudArtifactRevisions.artifactId, artifactId), eq(cloudArtifactRevisions.userId, ownerId)))
      .orderBy(asc(cloudArtifactRevisions.createdAt), asc(cloudArtifactRevisions.id))
    return { artifact: artifactRecord(artifact), revisions: revisions.map(revisionRecord) }
  }
  const readObject = async (revision: typeof cloudArtifactRevisions.$inferSelect) => {
    const bytes = await objects.get(revision.objectKey)
    if (bytes.byteLength !== revision.byteLength || (await digestBytes(bytes)) !== revision.digest) {
      throw new ArtifactServiceError(503, 'Artifact snapshot failed its integrity check')
    }
    return ciphertextSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  }
  const content = async (ownerId: string, artifactId: string, revisionId: string) => {
    await ownedArtifact(database, ownerId, artifactId)
    const revision = await findRevision(database, ownerId, artifactId, revisionId)
    const value = await readObject(revision)
    await ownedArtifact(database, ownerId, artifactId)
    return { content: value }
  }
  const prepareUpload = async (input: PublishArtifactRevision) => {
    const content = ciphertextSchema.parse(input.content)
    ciphertextSchema.parse(input.manifest)
    const bytes = encoder.encode(JSON.stringify(content))
    if (bytes.byteLength > maxArtifactBytes || encoder.encode(JSON.stringify(input.manifest)).byteLength > 256_000) {
      throw new ArtifactServiceError(413, 'Artifact snapshot is too large')
    }
    const objectKey = `cloud-artifacts/${crypto.randomUUID()}`
    const digest = await digestBytes(bytes)
    await database
      .insert(cloudBlobCleanup)
      .values({ objectKey, deleteAfter: new Date(now().getTime() + retentionMs).toISOString() })
    await objects.put(objectKey, bytes)
    return { objectKey, digest, byteLength: bytes.byteLength }
  }
  const assertReservation = async (db: QueryableDatabase, objectKey: string) => {
    const [reservation] = await db
      .select()
      .from(cloudBlobCleanup)
      .where(eq(cloudBlobCleanup.objectKey, objectKey))
      .for('update')
    if (!reservation || new Date(reservation.deleteAfter).getTime() <= now().getTime()) {
      throw new ArtifactServiceError(409, 'Artifact upload expired before publication')
    }
  }
  const publish = async (
    ownerId: string,
    artifactId: string,
    input: PublishArtifactRevision,
    agentId?: string,
  ): Promise<CloudArtifactRevision> => {
    if (agentId) {
      await agentGrant(database, ownerId, agentId, artifactId, true)
    } else {
      await ownedArtifact(database, ownerId, artifactId)
    }
    const digest = await digestBytes(encoder.encode(JSON.stringify(ciphertextSchema.parse(input.content))))
    const [existing] = await database
      .select()
      .from(cloudArtifactRevisions)
      .where(eq(cloudArtifactRevisions.id, input.id))
    const acceptRetry = (existing: typeof cloudArtifactRevisions.$inferSelect) => {
      if (
        existing.userId !== ownerId ||
        existing.artifactId !== artifactId ||
        existing.parentRevisionId !== input.parentRevisionId ||
        existing.keyEpoch !== input.keyEpoch ||
        existing.digest !== digest ||
        JSON.stringify(ciphertextSchema.parse(existing.manifest)) !==
          JSON.stringify(ciphertextSchema.parse(input.manifest))
      ) {
        throw new ArtifactServiceError(409, 'Revision identifier already has different content')
      }
      return revisionRecord(existing)
    }
    if (existing) {
      return acceptRetry(existing)
    }
    const upload = await prepareUpload(input)
    return database.transaction(async (tx) => {
      await lockOwner(tx, ownerId)
      if (agentId) {
        await agentGrant(tx, ownerId, agentId, artifactId, true, true)
      }
      const artifact = await ownedArtifact(tx, ownerId, artifactId, true)
      const [retry] = await tx.select().from(cloudArtifactRevisions).where(eq(cloudArtifactRevisions.id, input.id))
      if (retry) {
        return acceptRetry(retry)
      }
      if (artifact.keyEpoch !== input.keyEpoch) {
        throw new ArtifactServiceError(409, 'Artifact key epoch changed')
      }
      if (input.parentRevisionId) {
        await findRevision(tx, ownerId, artifactId, input.parentRevisionId)
      }
      await assertReservation(tx, upload.objectKey)
      await checkStorageQuota(tx, ownerId, upload.byteLength)
      const conflict = artifact.currentRevisionId !== input.parentRevisionId
      const [revision] = await tx
        .insert(cloudArtifactRevisions)
        .values({
          ...upload,
          id: input.id,
          userId: ownerId,
          artifactId,
          parentRevisionId: input.parentRevisionId,
          keyEpoch: input.keyEpoch,
          manifest: input.manifest,
          conflict,
        })
        .returning()
      if (!conflict) {
        await tx.update(cloudArtifacts).set({ currentRevisionId: input.id }).where(eq(cloudArtifacts.id, artifactId))
      }
      await tx.delete(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, upload.objectKey))
      return revisionRecord(revision!)
    })
  }
  const encryptSnapshot = async (
    ownerId: string,
    artifactId: string,
    keyEpoch: number,
    key: CryptoKey,
    revisionId: string,
    snapshot: ArtifactSnapshot,
  ) => {
    validateFiles(snapshot.files)
    const manifest: ArtifactManifest = {
      title: snapshot.title,
      mediaType: snapshot.mediaType,
      files: snapshot.files.map(({ path, mediaType, content }) => ({
        path,
        mediaType,
        size: encoder.encode(content).byteLength,
      })),
    }
    manifestSchema.parse(manifest)
    return {
      manifest: await cryptography.encrypt(
        manifest,
        key,
        payloadContext(ownerId, artifactId, keyEpoch, revisionId, 'artifact-manifest'),
      ),
      content: await cryptography.encrypt(
        { files: snapshot.files },
        key,
        payloadContext(ownerId, artifactId, keyEpoch, revisionId, 'artifact-content'),
      ),
    }
  }
  const openRuntimeRevision = async (ownerId: string, agentId: string, artifactId: string, revisionId?: string) => {
    const { artifact, grant } = await agentGrant(database, ownerId, agentId, artifactId, false)
    const id = revisionId ?? artifact.currentRevisionId
    if (!id) {
      throw new ArtifactServiceError(404, 'Artifact has no published revision')
    }
    const revision = await findRevision(database, ownerId, artifactId, id)
    if (revision.keyEpoch !== artifact.keyEpoch) {
      throw new ArtifactServiceError(403, 'Agent has no grant for this artifact key epoch')
    }
    const key = await cryptography.openKey(
      grant.keyEnvelope,
      runtimeIdentity,
      grantContext(ownerId, artifactId, revision.keyEpoch, agentId),
    )
    const manifest = manifestSchema.parse(
      await cryptography.decrypt(
        revision.manifest,
        key,
        payloadContext(ownerId, artifactId, revision.keyEpoch, id, 'artifact-manifest'),
      ),
    )
    return { key, revision, manifest }
  }
  /** Listing metadata never downloads a potentially large snapshot from object storage. */
  const manifestFromRuntime = async (ownerId: string, agentId: string, artifactId: string) => {
    const { revision, manifest } = await openRuntimeRevision(ownerId, agentId, artifactId)
    await agentGrant(database, ownerId, agentId, artifactId, false)
    return { revision: revisionRecord(revision), manifest }
  }
  const readFromRuntime = async (ownerId: string, agentId: string, artifactId: string, revisionId?: string) => {
    const { key, revision, manifest } = await openRuntimeRevision(ownerId, agentId, artifactId, revisionId)
    const encrypted = await readObject(revision)
    const snapshot = snapshotSchema.parse(
      await cryptography.decrypt(
        encrypted,
        key,
        payloadContext(ownerId, artifactId, revision.keyEpoch, revision.id, 'artifact-content'),
      ),
    )
    validateFiles(snapshot.files)
    await agentGrant(database, ownerId, agentId, artifactId, false)
    return { revision: revisionRecord(revision), manifest, files: snapshot.files }
  }
  const createFromRuntime = async (
    ownerId: string,
    agentId: string,
    input: ArtifactSnapshot & { artifactId: string; revisionId: string },
    ownerRecipient: ResourcePublicKey,
  ): Promise<CloudArtifactState> => {
    await activeAgent(database, ownerId, agentId)
    const [existing] = await database.select().from(cloudArtifacts).where(eq(cloudArtifacts.id, input.artifactId))
    if (existing) {
      const saved = await readFromRuntime(ownerId, agentId, input.artifactId, input.revisionId)
      if (
        saved.manifest.title !== input.title ||
        saved.manifest.mediaType !== input.mediaType ||
        JSON.stringify(saved.files) !== JSON.stringify(snapshotSchema.parse({ files: input.files }).files)
      ) {
        throw new ArtifactServiceError(409, 'Artifact identifier already has different content')
      }
      return get(ownerId, input.artifactId)
    }
    const [owner] = await database
      .select({ id: cloudIdentities.userId })
      .from(cloudIdentities)
      .where(eq(cloudIdentities.userId, ownerId))
    if (!owner) {
      throw new ArtifactServiceError(409, 'Owner recovery identity is required')
    }
    const key = await cryptography.generateKey()
    const keyEpoch = 1
    const ownerKeyEnvelope = await cryptography.sealKey(key, ownerRecipient, {
      ownerId,
      scopeId: cloudArtifactScope(input.artifactId),
      keyEpoch,
      recipientId: ownerId,
    })
    const keyEnvelope = await cryptography.sealKey(
      key,
      runtimeIdentity.publicKey,
      grantContext(ownerId, input.artifactId, keyEpoch, agentId),
    )
    const encrypted = await encryptSnapshot(ownerId, input.artifactId, keyEpoch, key, input.revisionId, input)
    const revision = { ...encrypted, id: input.revisionId, keyEpoch, parentRevisionId: null }
    const upload = await prepareUpload(revision)
    const inserted = await database.transaction(async (tx) => {
      await lockOwner(tx, ownerId)
      await activeAgent(tx, ownerId, agentId, true)
      await assertReservation(tx, upload.objectKey)
      const [created] = await tx
        .insert(cloudArtifacts)
        .values({
          id: input.artifactId,
          userId: ownerId,
          keyEpoch,
          ownerKeyEnvelope,
          currentRevisionId: input.revisionId,
        })
        .onConflictDoNothing()
        .returning()
      if (!created) {
        return false
      }
      await checkStorageQuota(tx, ownerId, upload.byteLength)
      await tx.insert(cloudArtifactGrants).values({
        artifactId: input.artifactId,
        recipientId: agentId,
        recipientKind: 'agent',
        keyEpoch,
        keyEnvelope,
        canWrite: true,
      })
      await tx.insert(cloudArtifactRevisions).values({
        ...upload,
        id: input.revisionId,
        userId: ownerId,
        artifactId: input.artifactId,
        keyEpoch,
        parentRevisionId: null,
        manifest: encrypted.manifest,
      })
      await tx.delete(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, upload.objectKey))
      return true
    })
    if (!inserted) {
      return createFromRuntime(ownerId, agentId, input, ownerRecipient)
    }
    return get(ownerId, input.artifactId)
  }
  const publishFromRuntime = async (
    ownerId: string,
    agentId: string,
    artifactId: string,
    input: ArtifactSnapshot & { revisionId: string; parentRevisionId: string | null },
  ) => {
    const { artifact, grant } = await agentGrant(database, ownerId, agentId, artifactId, true)
    const [existing] = await database
      .select()
      .from(cloudArtifactRevisions)
      .where(eq(cloudArtifactRevisions.id, input.revisionId))
    if (existing) {
      const saved = await readFromRuntime(ownerId, agentId, artifactId, input.revisionId)
      if (
        saved.revision.parentRevisionId !== input.parentRevisionId ||
        saved.manifest.title !== input.title ||
        saved.manifest.mediaType !== input.mediaType ||
        JSON.stringify(saved.files) !== JSON.stringify(snapshotSchema.parse({ files: input.files }).files)
      ) {
        throw new ArtifactServiceError(409, 'Revision identifier already has different content')
      }
      return saved.revision
    }
    const key = await cryptography.openKey(
      grant.keyEnvelope,
      runtimeIdentity,
      grantContext(ownerId, artifactId, artifact.keyEpoch, agentId),
    )
    const encrypted = await encryptSnapshot(ownerId, artifactId, artifact.keyEpoch, key, input.revisionId, input)
    return publish(
      ownerId,
      artifactId,
      { ...encrypted, id: input.revisionId, parentRevisionId: input.parentRevisionId, keyEpoch: artifact.keyEpoch },
      agentId,
    )
  }
  const grantAgent = async (
    ownerId: string,
    artifactId: string,
    input: { agentId: string; keyEpoch: number; keyEnvelope: ResourceKeyEnvelope; canWrite: boolean },
  ) => {
    const key = await cryptography.openKey(
      input.keyEnvelope,
      runtimeIdentity,
      grantContext(ownerId, artifactId, input.keyEpoch, input.agentId),
    )
    const current = await ownedArtifact(database, ownerId, artifactId)
    if (current.currentRevisionId) {
      const revision = await findRevision(database, ownerId, artifactId, current.currentRevisionId)
      await cryptography.decrypt(
        revision.manifest,
        key,
        payloadContext(ownerId, artifactId, input.keyEpoch, revision.id, 'artifact-manifest'),
      )
    }
    await database.transaction(async (tx) => {
      await activeAgent(tx, ownerId, input.agentId, true)
      const artifact = await ownedArtifact(tx, ownerId, artifactId, true)
      if (artifact.keyEpoch !== input.keyEpoch) {
        throw new ArtifactServiceError(409, 'Artifact key epoch changed')
      }
      await tx
        .insert(cloudArtifactGrants)
        .values({
          artifactId,
          recipientId: input.agentId,
          recipientKind: 'agent',
          keyEpoch: input.keyEpoch,
          keyEnvelope: input.keyEnvelope,
          canWrite: input.canWrite,
        })
        .onConflictDoUpdate({
          target: [cloudArtifactGrants.artifactId, cloudArtifactGrants.recipientId, cloudArtifactGrants.keyEpoch],
          set: { keyEnvelope: input.keyEnvelope, canWrite: input.canWrite, revokedAt: null },
        })
    })
  }
  const revokeGrant = async (ownerId: string, artifactId: string, agentId: string) => {
    await database.transaction(async (tx) => {
      await ownedArtifact(tx, ownerId, artifactId, true)
      await tx
        .update(cloudArtifactGrants)
        .set({ revokedAt: now().toISOString() })
        .where(
          and(
            eq(cloudArtifactGrants.artifactId, artifactId),
            eq(cloudArtifactGrants.recipientId, agentId),
            eq(cloudArtifactGrants.recipientKind, 'agent'),
          ),
        )
    })
  }
  /** Never remove a referenced snapshot; serialize cleanup with reservation consumption at publication. */
  const collectGarbage = async (limit = 100): Promise<number> => {
    const candidates = await database
      .select()
      .from(cloudBlobCleanup)
      .where(lte(cloudBlobCleanup.deleteAfter, now().toISOString()))
      .limit(limit)
    const removed = await Promise.all(
      candidates.map((candidate) =>
        database.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(cloudBlobCleanup)
            .where(
              and(
                eq(cloudBlobCleanup.objectKey, candidate.objectKey),
                lte(cloudBlobCleanup.deleteAfter, now().toISOString()),
              ),
            )
            .for('update')
          if (!reservation) {
            return 0
          }
          const [referenced] = await tx
            .select({ id: cloudArtifactRevisions.id })
            .from(cloudArtifactRevisions)
            .where(eq(cloudArtifactRevisions.objectKey, candidate.objectKey))
            .limit(1)
          if (referenced) {
            await tx.delete(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, candidate.objectKey))
            return 0
          }
          await objects.remove(candidate.objectKey)
          await tx.delete(cloudBlobCleanup).where(eq(cloudBlobCleanup.objectKey, candidate.objectKey))
          return 1
        }),
      ),
    )
    return removed.reduce<number>((total, value) => total + value, 0)
  }
  return {
    list: async (ownerId: string): Promise<CloudArtifact[]> =>
      (
        await database
          .select()
          .from(cloudArtifacts)
          .where(and(eq(cloudArtifacts.userId, ownerId), isNull(cloudArtifacts.deletedAt)))
          .orderBy(asc(cloudArtifacts.createdAt))
      ).map(artifactRecord),
    grants: async (ownerId: string, artifactId: string) => {
      await ownedArtifact(database, ownerId, artifactId)
      const rows = await database
        .select()
        .from(cloudArtifactGrants)
        .where(and(eq(cloudArtifactGrants.artifactId, artifactId), eq(cloudArtifactGrants.recipientKind, 'agent')))
      return rows.map(({ recipientId, keyEpoch, canWrite, revokedAt }) => ({
        agentId: recipientId,
        keyEpoch,
        canWrite,
        revokedAt,
      }))
    },
    get,
    content,
    publish,
    createFromRuntime,
    readFromRuntime,
    manifestFromRuntime,
    publishFromRuntime,
    grantAgent,
    revokeGrant,
    collectGarbage,
    softDelete: async (ownerId: string, artifactId: string): Promise<void> => {
      await ownedArtifact(database, ownerId, artifactId)
      await database
        .update(cloudArtifacts)
        .set({ deletedAt: now().toISOString() })
        .where(and(eq(cloudArtifacts.id, artifactId), eq(cloudArtifacts.userId, ownerId)))
    },
  }
}

export type ArtifactService = ReturnType<typeof createArtifactService>
