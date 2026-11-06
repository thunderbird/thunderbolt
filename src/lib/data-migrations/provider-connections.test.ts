/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { afterAll, beforeEach, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  integrationsSecretsTable,
  modelsSecretsTable,
  modelsTable,
  providerConnectionsTable,
  providerConnectionSecretsTable,
} from '@/db/tables'
import {
  getProviderCredentials,
  getProviderConnections,
  disconnectProviderConnection,
  saveProviderConnectionInTransaction,
} from '@/dal/provider-connections'
import { credentialBinding } from '@/providers/credentials'
import { migrateProviderConnections } from './provider-connections'

beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)
const url = 'https://otari.example/api/v1'
const legacyModel = async (id: string, apiKey = 'key', linked = false) => {
  await getDb()
    .insert(modelsTable)
    .values({
      id,
      provider: 'otari',
      name: id,
      model: id,
      url,
      providerConnectionId: linked ? `legacy-model:${id}` : null,
      enabled: 0,
    })
  await getDb().insert(modelsSecretsTable).values({ modelId: id, apiKey })
}
const syncedConnection = (id: string, overrides: Partial<typeof providerConnectionsTable.$inferInsert> = {}) =>
  getDb()
    .insert(providerConnectionsTable)
    .values({
      id: `legacy-model:${id}`,
      provider: 'otari',
      name: `Otari — ${id}`,
      url,
      authMethod: 'api_key',
      enabled: 1,
      ...overrides,
    })

it('moves this device’s key even when another device has already synced the model reference', async () => {
  await legacyModel('linked', 'device-b-key', true)
  await syncedConnection('linked')
  await migrateProviderConnections(getDb())
  expect((await getProviderCredentials(getDb(), 'legacy-model:linked'))?.apiKey).toBe('device-b-key')
  expect(await getDb().select().from(modelsTable).where(eq(modelsTable.id, 'linked')).get()).toMatchObject({
    providerConnectionId: 'legacy-model:linked',
    url,
    enabled: 0,
  })
  expect(await getDb().select().from(modelsSecretsTable).get()).toMatchObject({ apiKey: null })
  await migrateProviderConnections(getDb())
  expect(await getProviderConnections(getDb())).toHaveLength(1)
})
it('uses a stable per-model connection even when device-local key grouping differs', async () => {
  await legacyModel('a', 'same-key')
  await legacyModel('b', 'same-key')
  await migrateProviderConnections(getDb())
  expect((await getDb().select().from(modelsTable)).map(({ providerConnectionId }) => providerConnectionId)).toEqual([
    'legacy-model:a',
    'legacy-model:b',
  ])
  // The same synced metadata on another device can carry that device's independently configured keys.
  await getDb().delete(providerConnectionSecretsTable)
  await getDb().update(modelsSecretsTable).set({ apiKey: 'device-b-a' }).where(eq(modelsSecretsTable.modelId, 'a'))
  await getDb().update(modelsSecretsTable).set({ apiKey: 'device-b-b' }).where(eq(modelsSecretsTable.modelId, 'b'))
  await migrateProviderConnections(getDb())
  expect((await getProviderCredentials(getDb(), 'legacy-model:a'))?.apiKey).toBe('device-b-a')
  expect((await getProviderCredentials(getDb(), 'legacy-model:b'))?.apiKey).toBe('device-b-b')
  expect((await getProviderConnections(getDb())).map(({ name }) => name)).toEqual(['Otari — a', 'Otari — b'])
})
it.each(['disconnected', 'replaced'] as const)(
  'does not overwrite a %s local connection during a retry',
  async (state) => {
    await legacyModel('edited', 'old-key', true)
    await syncedConnection('edited')
    const credentials =
      state === 'disconnected'
        ? { sessionRevision: 'disconnected' }
        : { apiKey: 'replacement', sessionRevision: 'replaced' }
    const binding =
      state === 'disconnected' ? null : credentialBinding({ provider: 'otari', authMethod: 'api_key', url })
    await getDb()
      .insert(providerConnectionSecretsTable)
      .values({ id: 'legacy-model:edited', credentials: JSON.stringify(credentials), binding })
    await migrateProviderConnections(getDb())
    expect(await getDb().select().from(providerConnectionSecretsTable).get()).toMatchObject({
      credentials: JSON.stringify(credentials),
      binding,
    })
    expect((await getDb().select().from(modelsSecretsTable).get())?.apiKey).toBeNull()
  },
)
it.each([
  { url: 'https://changed.example/api/v1' },
  { provider: 'tinfoil' as const },
  { authMethod: 'oauth' as const },
])('does not attach a legacy key to changed synced metadata (%j)', async (change) => {
  await legacyModel('changed', 'private-key', true)
  await syncedConnection('changed', change)
  await migrateProviderConnections(getDb())
  expect(await getDb().select().from(providerConnectionSecretsTable)).toHaveLength(0)
  expect((await getDb().select().from(modelsSecretsTable).get())?.apiKey).toBe('private-key')
  expect((await getDb().select().from(modelsTable).get())?.url).toBe(url)
})
it('honors a synced connection deletion without reviving the old credential', async () => {
  await legacyModel('removed', 'old-key', true)
  await syncedConnection('removed', { deletedAt: new Date().toISOString() })
  await migrateProviderConnections(getDb())
  expect(await getProviderConnections(getDb())).toHaveLength(0)
  expect(await getDb().select().from(providerConnectionSecretsTable)).toHaveLength(0)
})
it('normalizes a legacy Otari origin before comparing its existing binding', async () => {
  await legacyModel('origin', 'key', true)
  await getDb().update(modelsTable).set({ url: 'https://otari.example/' }).where(eq(modelsTable.id, 'origin'))
  await syncedConnection('origin')
  await migrateProviderConnections(getDb())
  expect((await getProviderCredentials(getDb(), 'legacy-model:origin'))?.apiKey).toBe('key')
})
it.each([true, false])(
  'moves one legacy Tinfoil OAuth session without changing its enabled state (%s)',
  async (enabled) => {
    await getDb()
      .insert(integrationsSecretsTable)
      .values({
        provider: 'tinfoil',
        credentials: JSON.stringify({ access_token: 'token', refresh_token: 'refresh', expires_at: 9999999999999 }),
        enabled: enabled ? 1 : 0,
      })
    for (const id of ['a', 'b']) {
      await getDb().insert(modelsTable).values({ id, provider: 'tinfoil', name: id, model: id })
      await getDb().insert(modelsSecretsTable).values({ modelId: id, oauthProvider: 'tinfoil' })
    }
    await migrateProviderConnections(getDb())
    expect(await getProviderConnections(getDb())).toHaveLength(1)
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({ id: 'oauth:tinfoil', enabled: enabled ? 1 : 0 })
    expect(
      (await getDb().select().from(modelsTable)).every(
        ({ providerConnectionId }) => providerConnectionId === 'oauth:tinfoil',
      ),
    ).toBe(true)
    expect((await getDb().select().from(integrationsSecretsTable).get())?.credentials).toBeNull()
  },
)
it('hydrates a previously synced OAuth connection with this device’s legacy session', async () => {
  await getDb()
    .insert(providerConnectionsTable)
    .values({ id: 'oauth:tinfoil', provider: 'tinfoil', name: 'Tinfoil', authMethod: 'oauth', enabled: 1 })
  await getDb()
    .insert(integrationsSecretsTable)
    .values({
      provider: 'tinfoil',
      credentials: JSON.stringify({ access_token: 'device-b-token', expires_at: Date.now() + 3_600_000 }),
      enabled: 1,
    })
  await migrateProviderConnections(getDb())
  expect((await getProviderCredentials(getDb(), 'oauth:tinfoil'))?.access_token).toBe('device-b-token')
})
it('does not replace a newer OAuth grant with a legacy session', async () => {
  await getDb().transaction((tx) =>
    saveProviderConnectionInTransaction(tx, {
      provider: 'tinfoil',
      name: 'Tinfoil',
      authMethod: 'oauth',
      credentials: { access_token: 'new-token', expires_at: Date.now() + 3_600_000 },
    }),
  )
  await getDb()
    .insert(integrationsSecretsTable)
    .values({ provider: 'tinfoil', credentials: JSON.stringify({ access_token: 'old-token' }), enabled: 1 })
  await migrateProviderConnections(getDb())
  expect((await getProviderCredentials(getDb(), 'oauth:tinfoil'))?.access_token).toBe('new-token')
})
it.each([false, true])(
  'migrates a keyless custom connection once, including already-linked models (%s)',
  async (linked) => {
    const customUrl = 'http://localhost:1234/v1'
    await getDb()
      .insert(modelsTable)
      .values({
        id: 'local',
        provider: 'custom',
        name: 'Local',
        model: 'test',
        url: customUrl,
        providerConnectionId: linked ? 'legacy-model:local' : null,
      })
    if (linked) {
      await syncedConnection('local', { provider: 'custom', url: customUrl })
    }
    await migrateProviderConnections(getDb())
    const beforeRetry = await getDb().get<{ changes: number }>(sql`SELECT total_changes() AS changes`)
    await migrateProviderConnections(getDb())
    expect(await getDb().get(sql`SELECT total_changes() AS changes`)).toEqual(beforeRetry)
    expect(await getProviderConnections(getDb())).toHaveLength(1)
    expect((await getProviderConnections(getDb()))[0].connected).toBe(true)
  },
)

it('does not authorize a keyless custom server whose synced URL changed', async () => {
  await getDb().insert(modelsTable).values({
    id: 'local',
    provider: 'custom',
    name: 'Local',
    model: 'test',
    url: 'http://localhost:1234/v1',
    providerConnectionId: 'legacy-model:local',
  })
  await syncedConnection('local', { provider: 'custom', url: 'https://different.example/v1' })
  await migrateProviderConnections(getDb())
  expect(await getDb().select().from(providerConnectionSecretsTable)).toHaveLength(0)
  expect((await getProviderConnections(getDb()))[0].connected).toBe(false)
})

it('does not authorize a new synced keyless connection without a legacy model URL', async () => {
  await getDb().insert(modelsTable).values({
    id: 'new',
    provider: 'custom',
    name: 'New',
    model: 'test',
    providerConnectionId: 'new-connection',
  })
  await syncedConnection('new', { id: 'new-connection', provider: 'custom', url: 'https://new.example/v1' })
  await migrateProviderConnections(getDb())
  expect(await getDb().select().from(providerConnectionSecretsTable)).toHaveLength(0)
  expect((await getProviderConnections(getDb()))[0].connected).toBe(false)
})

it('does not reconnect a migrated keyless server after a local disconnect', async () => {
  await getDb().insert(modelsTable).values({
    id: 'local',
    provider: 'custom',
    name: 'Local',
    model: 'test',
    url: 'http://localhost:1234/v1',
  })
  await migrateProviderConnections(getDb())
  await disconnectProviderConnection(getDb(), 'legacy-model:local')
  await migrateProviderConnections(getDb())
  expect((await getProviderConnections(getDb()))[0].connected).toBe(false)
})
