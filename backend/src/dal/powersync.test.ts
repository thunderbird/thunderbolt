/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { chatThreadsTable, devicesTable, modelsTable, settingsTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { applyOperation } from './powersync'

describe('powersync upload gate (applyOperation)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const userId = 'user-a'
  const otherUserId = 'user-b'

  const insertUser = async (id: string, email: string) => {
    const now = new Date()
    await db.insert(user).values({ id, name: id, email, emailVerified: true, createdAt: now, updatedAt: now })
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    await insertUser(userId, 'a@test.com')
    await insertUser(otherUserId, 'b@test.com')
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  describe('invalid / malformed operations', () => {
    it('rejects an unknown table name', async () => {
      const ok = await applyOperation(db, { op: 'PUT', type: 'not_a_table', id: 'x', data: { foo: 1 } }, userId)
      expect(ok).toBe(false)
    })
  })

  describe('DELETE allowlist (security: protected tables)', () => {
    it('REFUSES to delete a devices row via upload — identity-deletion vector', async () => {
      const now = new Date()
      await db
        .insert(devicesTable)
        .values({ id: 'dev-1', userId, name: 'Phone', trusted: true, lastSeen: now, createdAt: now })

      const ok = await applyOperation(db, { op: 'DELETE', type: 'devices', id: 'dev-1' }, userId)

      expect(ok).toBe(false)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'dev-1'))
      // row fully intact — not deleted, not mutated
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe('Phone')
      expect(rows[0].trusted).toBe(true)
      expect(rows[0].revokedAt).toBeNull()
    })

    it('allows deleting a non-protected table row owned by the user', async () => {
      await applyOperation(db, { op: 'PUT', type: 'models', id: 'm-del', data: { name: 'Custom' } }, userId)

      const ok = await applyOperation(db, { op: 'DELETE', type: 'models', id: 'm-del' }, userId)

      expect(ok).toBe(true)
      const rows = await db.select().from(modelsTable).where(eq(modelsTable.id, 'm-del'))
      expect(rows).toHaveLength(0)
    })

    it('does NOT delete another user’s row even on an allowed table (user isolation)', async () => {
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-iso', data: { title: 'A' } }, userId)

      // user-b tries to delete user-a's thread (chat_threads pk is global id)
      const ok = await applyOperation(db, { op: 'DELETE', type: 'chat_threads', id: 't-iso' }, otherUserId)

      expect(ok).toBe(false)
      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-iso'))
      expect(rows).toHaveLength(1)
      expect(rows[0].userId).toBe(userId)
    })

    it('returns false when deleting a non-existent row', async () => {
      const ok = await applyOperation(db, { op: 'DELETE', type: 'models', id: 'ghost' }, userId)
      expect(ok).toBe(false)
    })
  })

  describe('PUT (insert-or-upsert)', () => {
    it('forces user_id to the authenticated user, ignoring a spoofed payload user_id', async () => {
      const ok = await applyOperation(
        db,
        { op: 'PUT', type: 'chat_threads', id: 't-spoof', data: { title: 'Mine', user_id: otherUserId } },
        userId,
      )

      expect(ok).toBe(true)
      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-spoof'))
      expect(rows[0].userId).toBe(userId)
    })

    it('ignores a spoofed payload id and uses op.id', async () => {
      await applyOperation(
        db,
        { op: 'PUT', type: 'chat_threads', id: 'real-id', data: { id: 'fake-id', title: 'X' } },
        userId,
      )
      const real = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'real-id'))
      const fake = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'fake-id'))
      expect(real).toHaveLength(1)
      expect(fake).toHaveLength(0)
    })

    it('strips EVERY server-managed deny column on devices (client cannot grant itself trust)', async () => {
      const ok = await applyOperation(
        db,
        {
          op: 'PUT',
          type: 'devices',
          id: 'dev-trust',
          data: {
            name: 'Evil', // the only non-protected field
            trusted: true,
            approval_pending: true,
            public_key: 'attacker-pk',
            mlkem_public_key: 'attacker-mlkem',
            revoked_at: '2020-01-01T00:00:00.000Z',
            app_version: '99.99.99',
            device_type: 'bridge',
            node_id: 'attacker-node',
            node_id_attested_at: '2020-01-01T00:00:00.000Z',
          },
        },
        userId,
      )

      expect(ok).toBe(true)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'dev-trust'))
      expect(rows[0].name).toBe('Evil') // non-protected column is applied
      expect(rows[0].trusted).toBe(false) // server-managed defaults, never client-set
      expect(rows[0].approvalPending).toBe(false)
      expect(rows[0].publicKey).toBeNull()
      expect(rows[0].mlkemPublicKey).toBeNull()
      expect(rows[0].revokedAt).toBeNull()
      expect(rows[0].appVersion).toBeNull()
      expect(rows[0].deviceType).toBe('normal') // client can't relabel itself a bridge
      expect(rows[0].nodeId).toBeNull()
      expect(rows[0].nodeIdAttestedAt).toBeNull()
    })

    it('REFUSES to create a devices row in the reserved bridge- id namespace (squat vector)', async () => {
      // The bridge- id namespace is server-owned (POST /devices/bridge). A client upload must not
      // be able to pre-create a row there, or it could squat another account's deterministic
      // bridge id and block that account's later registration.
      const ok = await applyOperation(
        db,
        { op: 'PUT', type: 'devices', id: 'bridge-deadbeef', data: { name: 'Squat' } },
        userId,
      )
      expect(ok).toBe(false)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'bridge-deadbeef'))
      expect(rows).toHaveLength(0)
    })

    it('updates an existing row on conflict (upsert)', async () => {
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-up', data: { title: 'First' } }, userId)
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-up', data: { title: 'Second' } }, userId)

      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-up'))
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toBe('Second')
    })

    it('does NOT overwrite another user’s row when a global-pk id collides (cross-user isolation)', async () => {
      await applyOperation(
        db,
        { op: 'PUT', type: 'chat_threads', id: 't-shared', data: { title: 'Owned by A' } },
        userId,
      )

      // user-b PUTs the same global id; insert conflicts, but setWhere(userId=b) matches no row
      const ok = await applyOperation(
        db,
        { op: 'PUT', type: 'chat_threads', id: 't-shared', data: { title: 'Hijacked by B' } },
        otherUserId,
      )

      expect(ok).toBe(true) // gate accepts (no error) but the update affects 0 rows
      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-shared'))
      expect(rows).toHaveLength(1)
      expect(rows[0].userId).toBe(userId)
      expect(rows[0].title).toBe('Owned by A')
    })

    it('does not clobber an existing row when an upsert carries no real columns (only unknowns)', async () => {
      await applyOperation(db, { op: 'PUT', type: 'models', id: 'm-noop', data: { name: 'Original' } }, userId)

      // data has only unknown columns -> the conflicting upsert has nothing to update
      const ok = await applyOperation(db, { op: 'PUT', type: 'models', id: 'm-noop', data: { bogus: 'z' } }, userId)

      expect(ok).toBe(true)
      const rows = await db.select().from(modelsTable).where(eq(modelsTable.id, 'm-noop'))
      expect(rows[0].name).toBe('Original') // untouched, no clobber to null
    })

    it('creates a bare row (id + user_id + defaults) when an insert carries only unknown columns', async () => {
      const ok = await applyOperation(db, { op: 'PUT', type: 'models', id: 'm-bare', data: { bogus: 'z' } }, userId)

      expect(ok).toBe(true)
      const rows = await db.select().from(modelsTable).where(eq(modelsTable.id, 'm-bare'))
      expect(rows).toHaveLength(1)
      expect(rows[0].userId).toBe(userId)
      expect(rows[0].name).toBeNull()
      expect(rows[0].enabled).toBe(1) // schema default applied
    })

    it('converts ISO timestamp strings to Date on the PUT path too', async () => {
      const iso = '2026-03-04T05:06:07.000Z'
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-put-ts', data: { deleted_at: iso } }, userId)
      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-put-ts'))
      expect(rows[0].deletedAt).toBeInstanceOf(Date)
      expect(rows[0].deletedAt!.toISOString()).toBe(iso)
    })

    it('upserts settings whose DB pk column is named "id" but maps to the "key" field', async () => {
      await applyOperation(db, { op: 'PUT', type: 'settings', id: 'theme', data: { value: 'dark' } }, userId)
      await applyOperation(db, { op: 'PUT', type: 'settings', id: 'theme', data: { value: 'light' } }, userId)

      const rows = await db
        .select()
        .from(settingsTable)
        .where(and(eq(settingsTable.key, 'theme'), eq(settingsTable.userId, userId)))
      expect(rows).toHaveLength(1)
      expect(rows[0].value).toBe('light')
    })
  })

  describe('PATCH', () => {
    it('returns true (drainable no-op) for empty data and leaves the target untouched', async () => {
      await applyOperation(db, { op: 'PUT', type: 'models', id: 'm-empty', data: { name: 'Keep' } }, userId)
      const ok = await applyOperation(db, { op: 'PATCH', type: 'models', id: 'm-empty', data: {} }, userId)
      expect(ok).toBe(true)
      const rows = await db.select().from(modelsTable).where(eq(modelsTable.id, 'm-empty'))
      expect(rows[0].name).toBe('Keep')
    })

    it('returns true (drainable no-op) when data is omitted entirely', async () => {
      const ok = await applyOperation(db, { op: 'PATCH', type: 'models', id: 'whatever' }, userId)
      expect(ok).toBe(true)
    })

    it('strips a spoofed id from the patch so it cannot rewrite the primary key', async () => {
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-pid', data: { title: 'Orig' } }, userId)

      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'chat_threads', id: 't-pid', data: { id: 'hijack', title: 'New' } },
        userId,
      )

      expect(ok).toBe(true)
      const stillThere = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-pid'))
      const hijacked = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'hijack'))
      expect(stillThere[0].title).toBe('New') // allowed field applied
      expect(hijacked).toHaveLength(0) // pk untouched
    })

    it('clears a timestamp column when patched with null (un-soft-delete)', async () => {
      const iso = '2026-01-02T03:04:05.000Z'
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-undel', data: { deleted_at: iso } }, userId)

      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'chat_threads', id: 't-undel', data: { deleted_at: null } },
        userId,
      )

      expect(ok).toBe(true)
      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-undel'))
      expect(rows[0].deletedAt).toBeNull()
    })

    it('returns true (drainable no-op) when only unknown/server-managed columns remain after stripping', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({ id: 'dev-strip', userId, name: 'Phone', lastSeen: now, createdAt: now })

      // trusted is deny-listed, user_id is stripped, foo is unknown -> empty patch
      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'devices', id: 'dev-strip', data: { trusted: true, user_id: otherUserId, foo: 1 } },
        userId,
      )

      expect(ok).toBe(true)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'dev-strip'))
      expect(rows[0].trusted).toBe(false)
      expect(rows[0].userId).toBe(userId)
    })

    it('applies allowed columns but strips deny-listed ones in the same patch', async () => {
      const now = new Date()
      await db.insert(devicesTable).values({ id: 'dev-mix', userId, name: 'Old', lastSeen: now, createdAt: now })

      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'devices', id: 'dev-mix', data: { name: 'Renamed', trusted: true } },
        userId,
      )

      expect(ok).toBe(true)
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, 'dev-mix'))
      expect(rows[0].name).toBe('Renamed')
      expect(rows[0].trusted).toBe(false)
    })

    it('returns false when patching a non-existent row', async () => {
      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'chat_threads', id: 'nope', data: { title: 'X' } },
        userId,
      )
      expect(ok).toBe(false)
    })

    it('does not patch another user’s row and reports false', async () => {
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-patch-iso', data: { title: 'A' } }, userId)

      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'chat_threads', id: 't-patch-iso', data: { title: 'B' } },
        otherUserId,
      )

      expect(ok).toBe(false)
      const rows = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't-patch-iso'))
      expect(rows[0].title).toBe('A')
    })

    it('converts ISO timestamp strings to Date for timestamp columns (soft-delete)', async () => {
      await applyOperation(db, { op: 'PUT', type: 'chat_threads', id: 't-ts', data: { title: 'A' } }, userId)
      const iso = '2026-01-02T03:04:05.000Z'

      const ok = await applyOperation(
        db,
        { op: 'PATCH', type: 'chat_threads', id: 't-ts', data: { deleted_at: iso } },
        userId,
      )

      expect(ok).toBe(true)
      const rows = await db
        .select()
        .from(chatThreadsTable)
        .where(and(eq(chatThreadsTable.id, 't-ts'), eq(chatThreadsTable.userId, userId)))
      expect(rows[0].deletedAt).toBeInstanceOf(Date)
      expect(rows[0].deletedAt!.toISOString()).toBe(iso)
    })
  })
})
