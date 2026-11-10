/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { afterAll, beforeEach, expect, it, spyOn } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { Database, getDb } from '@/db/database'
import { applySchema } from '@/db/apply-schema'
import { getModel, getSelectedModel } from '@/dal/models'
import { getSettings, updateSettings } from '@/dal/settings'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
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
  updateProviderConnection,
} from '@/dal/provider-connections'
import { credentialBinding } from '@/providers/credentials'
import * as providerConnections from '@/dal/provider-connections'
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
it.each([
  { provider: 'custom' as const, url: 'https://legacy.example/v1?api-version=2026-01-01' },
  { provider: 'custom' as const, url: 'https://username:password@legacy.example/v1' },
  { provider: 'custom' as const, url: 'https://legacy.example/v1#fragment' },
  { provider: 'custom' as const, url: 'ftp://legacy.example/v1' },
  { provider: 'custom' as const, url: 'not-a-url' },
  { provider: 'custom' as const, url: null },
  { provider: 'custom' as const, url: '   ' },
  { provider: 'otari' as const, url: 'https://legacy.example/unsupported-path' },
])('preserves incompatible legacy settings while migrating other rows (%j)', async (legacy) => {
  await legacyModel('a-valid')
  await getDb()
    .insert(modelsTable)
    .values({
      id: 'm-unsupported',
      name: 'Legacy model',
      model: 'legacy-model',
      enabled: 1,
      ...legacy,
    })
  await getDb().insert(modelsSecretsTable).values({
    modelId: 'm-unsupported',
    apiKey: 'retained-key',
    providerDefault: 1,
  })
  await getDb().insert(modelsTable).values({
    id: 'z-valid',
    name: 'OpenAI model',
    model: 'model',
    provider: 'openai',
  })
  await getDb().insert(modelsSecretsTable).values({ modelId: 'z-valid', apiKey: 'openai-key' })
  const originalModel = await getDb().select().from(modelsTable).where(eq(modelsTable.id, 'm-unsupported')).get()
  const originalSecret = await getDb()
    .select()
    .from(modelsSecretsTable)
    .where(eq(modelsSecretsTable.modelId, 'm-unsupported'))
    .get()

  await migrateProviderConnections(getDb())

  expect((await getProviderConnections(getDb())).map(({ id }) => id).sort()).toEqual([
    'legacy-model:a-valid',
    'legacy-model:z-valid',
  ])
  expect((await getProviderCredentials(getDb(), 'legacy-model:a-valid'))?.apiKey).toBe('key')
  expect((await getProviderCredentials(getDb(), 'legacy-model:z-valid'))?.apiKey).toBe('openai-key')
  expect(await getDb().select().from(modelsTable).where(eq(modelsTable.id, 'm-unsupported')).get()).toEqual(
    originalModel,
  )
  expect(
    await getDb().select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, 'm-unsupported')).get(),
  ).toEqual(originalSecret)
  expect(await getModel(getDb(), 'm-unsupported')).toMatchObject({
    url: legacy.url,
    apiKey: 'retained-key',
    providerConnectionId: null,
    enabled: 1,
  })
  const beforeRetry = await getDb().get<{ changes: number }>(sql`SELECT total_changes() AS changes`)
  await migrateProviderConnections(getDb())
  expect(await getDb().get(sql`SELECT total_changes() AS changes`)).toEqual(beforeRetry)
})
it('still rejects and rolls back an unrelated connection write failure', async () => {
  await legacyModel('valid')
  const failure = new Error('Connection storage failed')
  const save = spyOn(providerConnections, 'saveProviderConnectionInTransaction').mockRejectedValueOnce(failure)
  try {
    await expect(migrateProviderConnections(getDb())).rejects.toBe(failure)
    expect(await getProviderConnections(getDb())).toHaveLength(0)
    expect((await getDb().select().from(modelsSecretsTable).get())?.apiKey).toBe('key')
    expect((await getDb().select().from(modelsTable).get())?.providerConnectionId).toBeNull()
  } finally {
    save.mockRestore()
  }
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

it('does not create an API-key connection at another device’s synced OAuth identity', async () => {
  await getDb().insert(modelsTable).values({
    id: 'different-device-auth',
    provider: 'tinfoil',
    name: 'Tinfoil',
    model: 'test',
    providerConnectionId: 'oauth:tinfoil',
  })
  await getDb().insert(modelsSecretsTable).values({ modelId: 'different-device-auth', apiKey: 'device-b-key' })
  await migrateProviderConnections(getDb())
  expect(await getProviderConnections(getDb())).toEqual([])
  expect((await getDb().select().from(modelsSecretsTable).get())?.apiKey).toBe('device-b-key')
  await getDb().transaction((tx) =>
    saveProviderConnectionInTransaction(tx, {
      provider: 'tinfoil',
      name: 'Tinfoil',
      authMethod: 'oauth',
      credentials: { access_token: 'later-oauth', expires_at: Date.now() + 3_600_000 },
    }),
  )
  expect((await getProviderConnections(getDb()))[0].authMethod).toBe('oauth')
})

it('retains a legacy OAuth reference when another device has linked the model to an API-key connection', async () => {
  await getDb().insert(modelsTable).values({
    id: 'different-device-auth',
    provider: 'tinfoil',
    name: 'Tinfoil',
    model: 'test',
    providerConnectionId: 'legacy-model:different-device-auth',
  })
  await getDb().insert(modelsSecretsTable).values({ modelId: 'different-device-auth', oauthProvider: 'tinfoil' })
  await syncedConnection('different-device-auth', { provider: 'tinfoil', url: null })
  await migrateProviderConnections(getDb())
  expect((await getDb().select().from(modelsSecretsTable).get())?.oauthProvider).toBe('tinfoil')
})

it('persists an upgraded model and its local disconnect across actual database restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-provider-upgrade-'))
  const path = join(directory, 'profile.sqlite')
  const original = new Database()
  const reopened = new Database()
  const restarted = new Database()
  try {
    const db = await original.initialize({ type: 'bun-sqlite', path })
    await applySchema(db)
    await db.insert(modelsTable).values({
      id: 'old-profile',
      provider: 'custom',
      name: 'Existing model',
      model: 'existing',
      url: 'http://localhost:11434/v1/',
      enabled: 1,
      isSystem: 0,
    })
    await db.insert(modelsSecretsTable).values({ modelId: 'old-profile', apiKey: 'existing-device-key' })
    await updateSettings(db, { selected_model: 'old-profile' })
    await migrateProviderConnections(db)
    await original.close()

    const restored = await reopened.initialize({ type: 'bun-sqlite', path })
    await migrateProviderConnections(restored)
    expect(await getModel(restored, 'old-profile')).toMatchObject({
      id: 'old-profile',
      model: 'existing',
      enabled: 1,
      providerConnectionId: 'legacy-model:old-profile',
      apiKey: 'existing-device-key',
      url: 'http://localhost:11434/v1',
      connectionReady: true,
    })
    expect((await getSelectedModel(restored)).id).toBe('old-profile')
    await disconnectProviderConnection(restored, 'legacy-model:old-profile')
    await reopened.close()

    const disconnected = await restarted.initialize({ type: 'bun-sqlite', path })
    await migrateProviderConnections(disconnected)
    expect(await getModel(disconnected, 'old-profile')).toMatchObject({ enabled: 1, connectionReady: false })
    expect(await getProviderCredentials(disconnected, 'legacy-model:old-profile')).toBeNull()
    expect((await disconnected.select().from(modelsSecretsTable).get())?.apiKey).toBeNull()
    expect(await getSettings(disconnected, { selected_model: String })).toEqual({ selectedModel: 'old-profile' })
  } finally {
    await original.close()
    await reopened.close()
    await restarted.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps different local keys and selected-model intent when metadata moves between two profile databases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-provider-devices-'))
  const deviceA = new Database()
  const deviceB = new Database()
  const localSettings = useLocalSettingsStore.getState()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
  try {
    const a = await deviceA.initialize({ type: 'bun-sqlite', path: join(directory, 'device-a.sqlite') })
    const b = await deviceB.initialize({ type: 'bun-sqlite', path: join(directory, 'device-b.sqlite') })
    for (const [db, apiKey] of [
      [a, 'device-a-key'],
      [b, 'device-b-key'],
    ] as const) {
      await applySchema(db)
      await db.insert(modelsTable).values({
        id: 'shared-model',
        provider: 'custom',
        name: 'Shared model',
        model: 'shared',
        url: 'https://approved.example/v1',
        enabled: 1,
        isSystem: 0,
      })
      await db.insert(modelsSecretsTable).values({ modelId: 'shared-model', apiKey })
      await updateSettings(db, { selected_model: 'shared-model' })
    }
    await migrateProviderConnections(a)
    const [metadata] = await a.select().from(providerConnectionsTable)
    const [model] = await a.select().from(modelsTable)
    // Emulate metadata-first delivery; local-only tables are never copied.
    await b.insert(providerConnectionsTable).values(metadata)
    await b.update(modelsTable).set(model).where(eq(modelsTable.id, model.id))
    expect(await getProviderCredentials(b, metadata.id)).toBeNull()
    await migrateProviderConnections(b)
    expect((await getProviderCredentials(a, metadata.id))?.apiKey).toBe('device-a-key')
    expect((await getProviderCredentials(b, metadata.id))?.apiKey).toBe('device-b-key')
    expect((await getSelectedModel(b)).id).toBe('shared-model')

    await updateProviderConnection(a, metadata.id, { name: 'Renamed elsewhere', enabled: false })
    const [disabled] = await a.select().from(providerConnectionsTable)
    await b.update(providerConnectionsTable).set(disabled).where(eq(providerConnectionsTable.id, metadata.id))
    await migrateProviderConnections(b)
    expect(await getModel(b, model.id)).toMatchObject({
      enabled: 1,
      connectionName: 'Renamed elsewhere',
      connectionReady: false,
    })
    expect(await getSettings(b, { selected_model: String })).toEqual({ selectedModel: 'shared-model' })
    await b.update(providerConnectionsTable).set({ enabled: 1 }).where(eq(providerConnectionsTable.id, metadata.id))
    expect((await getSelectedModel(b)).id).toBe('shared-model')
    expect((await getProviderCredentials(b, metadata.id))?.apiKey).toBe('device-b-key')

    await b
      .update(providerConnectionsTable)
      .set({ url: 'https://unapproved.example/v1' })
      .where(eq(providerConnectionsTable.id, metadata.id))
    await migrateProviderConnections(b)
    expect(await getProviderCredentials(b, metadata.id)).toBeNull()
    expect(await getModel(b, model.id)).toMatchObject({ enabled: 1, connectionReady: false })
    expect(await getProviderCredentials(a, metadata.id)).toBeNull()
    const [local] = await b.select().from(providerConnectionSecretsTable)
    expect(JSON.parse(local.credentials!).apiKey).toBe('device-b-key')
  } finally {
    useLocalSettingsStore.setState(localSettings)
    await deviceA.close()
    await deviceB.close()
    await rm(directory, { recursive: true, force: true })
  }
})
