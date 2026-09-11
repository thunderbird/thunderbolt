/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { deleteUser } from './users'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { debugTranscriptClientsTable, debugTranscriptsTable } from '@/db/debug-transcript-schema'
import { hashDebugTranscriptClientKey, selfDebugTranscriptClientId } from '@/debug-transcripts/client-key'
import {
  createDebugTranscript,
  findDebugTranscriptClientByKeyHash,
  upsertSelfDebugTranscriptClient,
} from './debug-transcripts'

describe('debug transcript DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const env = await createTestDb()
    db = env.db
    cleanup = env.cleanup
  })
  afterEach(() => cleanup())

  it('hashes keys as lowercase hex sha256', () => {
    expect(hashDebugTranscriptClientKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('upserts the self client and rotates its hash', async () => {
    await upsertSelfDebugTranscriptClient(db, 'hash-1')
    await upsertSelfDebugTranscriptClient(db, 'hash-2')

    const rows = await db.select().from(debugTranscriptClientsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: selfDebugTranscriptClientId, name: 'Thunderbolt', keyHash: 'hash-2' })
  })

  it('finds a client by key hash, including revoked ones', async () => {
    const revokedAt = new Date('2026-09-01T00:00:00Z')
    await db.insert(debugTranscriptClientsTable).values({ id: 'acme', name: 'Acme', keyHash: 'acme-hash', revokedAt })

    expect(await findDebugTranscriptClientByKeyHash(db, 'acme-hash')).toEqual({ id: 'acme', revokedAt })
    expect(await findDebugTranscriptClientByKeyHash(db, 'nope')).toBeNull()
  })

  it('cascades local user deletion while preserving external transcripts', async () => {
    await db.insert(user).values({ id: 'u1', name: 'Local user', email: 'local@example.com' })
    await upsertSelfDebugTranscriptClient(db, 'h')
    await db.insert(debugTranscriptClientsTable).values({ id: 'acme', name: 'Acme', keyHash: 'a' })
    const base = { threadId: 't', schemaVersion: 1, payload: {}, userId: 'u1' }
    await createDebugTranscript(db, { id: 'local', clientId: 'self', localUserId: 'u1', ...base })
    await createDebugTranscript(db, { id: 'external', clientId: 'acme', localUserId: null, ...base })

    await deleteUser(db, 'u1')

    expect(await db.select({ id: debugTranscriptsTable.id }).from(debugTranscriptsTable)).toEqual([{ id: 'external' }])
  })
})
