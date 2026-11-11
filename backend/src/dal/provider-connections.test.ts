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

  it('accepts partial metadata and hydrates it without blocking later uploads', async () => {
    expect(
      await applyOperation(db, { op: 'PUT', type: 'provider_connections', id: connectionId, data: {} }, 'owner'),
    ).toBe(true)
    const [partial] = await db.select().from(providerConnectionsTable)
    expect(partial).toMatchObject({ provider: null, name: null, authMethod: null, enabled: 1 })

    expect(
      await applyOperation(
        db,
        { op: 'PATCH', type: 'provider_connections', id: connectionId, data: metadata },
        'owner',
      ),
    ).toBe(true)
    const [hydrated] = await db.select().from(providerConnectionsTable)
    expect(hydrated).toMatchObject({ provider: 'otari', name: 'Work Otari', authMethod: 'oauth' })
  })

  it.each(['PUT', 'PATCH'] as const)('accepts explicit null metadata in %s operations', async (op) => {
    await applyOperation(db, { op: 'PUT', type: 'provider_connections', id: connectionId, data: metadata }, 'owner')
    expect(
      await applyOperation(
        db,
        {
          op,
          type: 'provider_connections',
          id: connectionId,
          data: {
            provider: null,
            name: null,
            url: null,
            auth_method: null,
            enabled: null,
            created_at: null,
            updated_at: null,
          },
        },
        'owner',
      ),
    ).toBe(true)
    const [saved] = await db.select().from(providerConnectionsTable)
    expect(saved).toMatchObject({
      provider: null,
      name: null,
      url: null,
      authMethod: null,
      enabled: null,
      createdAt: null,
      updatedAt: null,
    })
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

  it.each([null, '2026-11-10T12:00:00.000Z'])(
    'preserves remote edits and deletion (%s) when an offline migration retries',
    async (deletedAt) => {
      await applyOperation(
        db,
        {
          op: 'PUT',
          type: 'provider_connections',
          id: connectionId,
          data: { ...metadata, url: 'https://new.example/api/v1', enabled: 0, deleted_at: deletedAt },
        },
        'owner',
      )
      const before = await db.select().from(providerConnectionsTable)
      for (const _attempt of [1, 2]) {
        expect(
          await applyOperation(
            db,
            {
              op: 'PUT',
              type: 'provider_connections',
              id: connectionId,
              data: { ...metadata, name: 'Old name', url: 'https://old.example/api/v1', enabled: 1, deleted_at: null },
              ifAbsent: true,
            },
            'owner',
          ),
        ).toBe(true)
      }
      expect(await db.select().from(providerConnectionsTable)).toEqual(before)
    },
  )

  it('creates a missing connection when an offline migration uses create-only upload', async () => {
    expect(
      await applyOperation(
        db,
        {
          op: 'PUT',
          type: 'provider_connections',
          id: connectionId,
          data: metadata,
          ifAbsent: true,
        },
        'owner',
      ),
    ).toBe(true)
    const [saved] = await db.select().from(providerConnectionsTable)
    expect(saved).toMatchObject({ id: connectionId, name: metadata.name, userId: 'owner', deletedAt: null })
  })

  it.each([
    { provider: 'tinfoil', expected: 'tinfoil', isSystem: 0, previous: null, deleted: false, applied: true },
    { provider: 'tinfoil', expected: 'tinfoil', isSystem: null, previous: null, deleted: false, applied: true },
    { provider: 'tinfoil', expected: 'tinfoil', isSystem: 0, previous: 'newer-link', deleted: false, applied: false },
    { provider: 'tinfoil', expected: 'tinfoil', isSystem: 0, previous: null, deleted: true, applied: false },
    { provider: 'openai', expected: 'tinfoil', isSystem: 0, previous: null, deleted: false, applied: false },
    { provider: 'tinfoil', expected: 'tinfoil', isSystem: 1, previous: null, deleted: false, applied: false },
    { provider: 'openai', expected: 'openai', isSystem: 1, previous: null, deleted: false, applied: true },
    { provider: 'custom', expected: 'custom', isSystem: 1, previous: null, deleted: false, applied: true },
  ] as const)(
    'conditionally links an offline migrated model without replacing remote state: %j',
    async ({ provider, expected, isSystem, previous, deleted, applied }) => {
      await db.insert(modelsTable).values({
        id: 'offline-model',
        userId: 'owner',
        provider,
        name: 'Remote model',
        isSystem,
        providerConnectionId: previous,
        deletedAt: deleted ? new Date('2026-11-10T12:00:00Z') : null,
      })
      const [before] = await db.select().from(modelsTable)
      for (const target of ['migration-link', 'later-migration-link']) {
        expect(
          await applyOperation(
            db,
            {
              op: 'PATCH',
              type: 'models',
              id: 'offline-model',
              data: { provider_connection_id: target },
              ifProviderConnectionUnset: { provider: expected },
            },
            'owner',
          ),
        ).toBe(true)
      }
      expect(await db.select().from(modelsTable)).toEqual([
        { ...before, providerConnectionId: applied ? 'migration-link' : previous },
      ])
    },
  )

  it('scopes migration links to their account and accepts missing models without creating them', async () => {
    for (const userId of ['owner', 'other']) {
      await db.insert(modelsTable).values({ id: 'same-model', userId, provider: 'custom' })
    }
    for (const id of ['same-model', 'missing-model']) {
      expect(
        await applyOperation(
          db,
          {
            op: 'PATCH',
            type: 'models',
            id,
            data: { provider_connection_id: 'local-link' },
            ifProviderConnectionUnset: { provider: 'custom' },
          },
          'owner',
        ),
      ).toBe(true)
    }
    const rows = await db.select().from(modelsTable).orderBy(modelsTable.userId)
    expect(rows.map(({ userId, providerConnectionId }) => ({ userId, providerConnectionId }))).toEqual([
      { userId: 'other', providerConnectionId: null },
      { userId: 'owner', providerConnectionId: 'local-link' },
    ])
  })

  it.each([
    { op: 'PUT', type: 'models', data: { provider_connection_id: 'link' }, provider: 'custom' },
    { op: 'DELETE', type: 'models', data: { provider_connection_id: 'link' }, provider: 'custom' },
    { op: 'PATCH', type: 'provider_connections', data: { provider_connection_id: 'link' }, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: { provider_connection_id: 'link', name: 'overwrite' }, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: { provider_connection_id: 'link', user_id: 'other' }, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: { provider_connection_id: null }, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: { provider_connection_id: ' ' }, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: {}, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: undefined, provider: 'custom' },
    { op: 'PATCH', type: 'models', data: { provider_connection_id: 'link' }, provider: 'thunderbolt' },
    { op: 'PATCH', type: 'models', data: { provider_connection_id: 'link' }, provider: 'unknown' },
  ] as const)(
    'rejects a migration-link condition outside its narrow payload: %j',
    async ({ provider, ...operation }) => {
      await db.insert(modelsTable).values({ id: 'model', userId: 'owner', provider: 'custom', name: 'Original' })
      const before = await db.select().from(modelsTable)
      expect(
        await applyOperation(db, { ...operation, id: 'model', ifProviderConnectionUnset: { provider } }, 'owner'),
      ).toBe(false)
      expect(await db.select().from(modelsTable)).toEqual(before)
    },
  )

  it('keeps deliberate model connection edits unconditional after migration', async () => {
    await db
      .insert(modelsTable)
      .values({ id: 'model', userId: 'owner', provider: 'custom', providerConnectionId: 'migration-link' })
    expect(
      await applyOperation(
        db,
        { op: 'PATCH', type: 'models', id: 'model', data: { provider_connection_id: 'chosen-link' } },
        'owner',
      ),
    ).toBe(true)
    expect((await db.select().from(modelsTable))[0].providerConnectionId).toBe('chosen-link')
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
