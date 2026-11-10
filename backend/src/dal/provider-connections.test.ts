/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { modelsTable, providerConnectionsTable } from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { applyOperation } from './powersync'

describe('provider connection sync', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const connectionId = 'oauth:otari'
  const metadata = { provider: 'otari', name: 'Work Otari', auth_method: 'oauth' }

  beforeEach(async () => {
    const environment = await createTestDb()
    db = environment.db
    cleanup = environment.cleanup
    await db.insert(user).values(
      ['owner', 'other'].map((id) => ({
        id,
        name: id,
        email: `${id}@provider.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    )
  })

  afterEach(async () => {
    await cleanup()
  })

  it('isolates stable OAuth IDs by authenticated account and supplies defaults', async () => {
    for (const userId of ['owner', 'other']) {
      expect(
        await applyOperation(
          db,
          { op: 'PUT', type: 'provider_connections', id: connectionId, data: { ...metadata, user_id: 'spoofed' } },
          userId,
        ),
      ).toBe(true)
    }
    const rows = await db.select().from(providerConnectionsTable)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.userId).sort()).toEqual(['other', 'owner'])
    for (const row of rows) {
      expect(row.id).toBe(connectionId)
      expect(row.enabled).toBe(1)
      expect(row.url).toBeNull()
      expect(row.deletedAt).toBeNull()
      expect(row.createdAt).toBeInstanceOf(Date)
      expect(row.updatedAt).toBeInstanceOf(Date)
    }
  })

  it('scopes updates, soft deletion, and deletes to the owning account', async () => {
    for (const userId of ['owner', 'other']) {
      await applyOperation(db, { op: 'PUT', type: 'provider_connections', id: connectionId, data: metadata }, userId)
    }
    const deletedAt = '2026-11-05T15:00:00.000Z'
    await applyOperation(
      db,
      {
        op: 'PATCH',
        type: 'provider_connections',
        id: connectionId,
        data: { id: 'replacement', user_id: 'other', name: 'Changed', enabled: 0, deleted_at: deletedAt },
      },
      'owner',
    )
    const own = await db.select().from(providerConnectionsTable).where(eq(providerConnectionsTable.userId, 'owner'))
    expect(own[0]).toMatchObject({ id: connectionId, name: 'Changed', enabled: 0, deletedAt: new Date(deletedAt) })
    await applyOperation(db, { op: 'DELETE', type: 'provider_connections', id: connectionId }, 'owner')
    const remaining = await db.select().from(providerConnectionsTable)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ userId: 'other', name: metadata.name, enabled: 1, deletedAt: null })
  })

  it('never persists provider credentials or accepts the device-local secret table', async () => {
    await applyOperation(
      db,
      {
        op: 'PUT',
        type: 'provider_connections',
        id: connectionId,
        data: { ...metadata, api_key: 'not-a-key', access_token: 'not-a-token', credentials: '{}', binding: 'x' },
      },
      'owner',
    )
    const [saved] = await db.select().from(providerConnectionsTable)
    expect(Object.keys(saved)).not.toContain('apiKey')
    expect(JSON.stringify(saved)).not.toContain('not-a-')
    expect(
      await applyOperation(
        db,
        { op: 'PUT', type: 'provider_connection_secrets', id: connectionId, data: { credentials: '{}' } },
        'owner',
      ),
    ).toBe(false)
  })

  it('accepts model references before connection metadata and preserves models after soft deletion', async () => {
    await applyOperation(db, { op: 'PUT', type: 'models', id: 'legacy', data: { name: 'Existing model' } }, 'owner')
    await applyOperation(
      db,
      { op: 'PUT', type: 'models', id: 'connected', data: { name: 'New model', provider_connection_id: connectionId } },
      'owner',
    )
    await applyOperation(db, { op: 'PUT', type: 'provider_connections', id: connectionId, data: metadata }, 'owner')
    await applyOperation(
      db,
      { op: 'PATCH', type: 'provider_connections', id: connectionId, data: { deleted_at: new Date().toISOString() } },
      'owner',
    )
    const rows = await db.select().from(modelsTable).where(eq(modelsTable.userId, 'owner'))
    expect(rows.find((row) => row.id === 'legacy')?.providerConnectionId).toBeNull()
    expect(rows.find((row) => row.id === 'connected')?.providerConnectionId).toBe(connectionId)
  })

  it('preserves existing metadata when an offline migration uses create-only upload', async () => {
    await applyOperation(db, { op: 'PUT', type: 'provider_connections', id: connectionId, data: metadata }, 'owner')
    await applyOperation(
      db,
      {
        op: 'PUT',
        type: 'provider_connections',
        id: connectionId,
        data: { ...metadata, name: 'Old name' },
        ifAbsent: true,
      },
      'owner',
    )
    const [saved] = await db.select().from(providerConnectionsTable)
    expect(saved.name).toBe(metadata.name)
  })

  it('removes metadata on account deletion without touching another account', async () => {
    for (const userId of ['owner', 'other']) {
      await applyOperation(db, { op: 'PUT', type: 'provider_connections', id: connectionId, data: metadata }, userId)
    }
    await db.delete(user).where(eq(user.id, 'owner'))
    expect(await db.select().from(providerConnectionsTable)).toHaveLength(1)
    expect(
      await db
        .select()
        .from(providerConnectionsTable)
        .where(and(eq(providerConnectionsTable.id, connectionId), eq(providerConnectionsTable.userId, 'other'))),
    ).toHaveLength(1)
  })
})
