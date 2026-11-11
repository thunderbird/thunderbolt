/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '../src/db/database-interface'
import { providerConnectionMigrationMetadata } from '../src/db/powersync/crud-metadata'
import { expect, test } from './test'

test('preserves migration-only metadata in the durable PowerSync queue without exporting it', async ({ page }) => {
  // Exercise the real SDK and app DAL without starting app initialization or connecting to sync.
  await page.route('**/__provider_migration__', (route) => route.fulfill({ body: '<!doctype html>' }))
  await page.goto('/__provider_migration__')
  const result = await page.evaluate(async () => {
    const schemaPath = '/src/db/powersync/schema.ts'
    const powerSyncPath = '/node_modules/@powersync/web/lib/index.js'
    const drizzlePath = '/node_modules/@powersync/drizzle-driver/lib/src/index.js'
    const migrationPath = '/src/lib/data-migrations/provider-connections.ts'
    const connectionsPath = '/src/dal/provider-connections.ts'
    const exportPath = '/src/dal/export.ts'
    const { AppSchema, drizzleSchema } = (await import(
      /* @vite-ignore */ schemaPath
    )) as typeof import('../src/db/powersync/schema')
    const { PowerSyncDatabase, WASQLiteVFS } = (await import(
      /* @vite-ignore */ powerSyncPath
    )) as typeof import('@powersync/web')
    const { wrapPowerSyncWithDrizzle } = (await import(
      /* @vite-ignore */ drizzlePath
    )) as typeof import('@powersync/drizzle-driver')
    const { migrateProviderConnections } = (await import(
      /* @vite-ignore */ migrationPath
    )) as typeof import('../src/lib/data-migrations/provider-connections')
    const { saveProviderConnection, updateProviderConnection, getProviderCredentials } = (await import(
      /* @vite-ignore */ connectionsPath
    )) as typeof import('../src/dal/provider-connections')
    const { exportUserData } = (await import(/* @vite-ignore */ exportPath)) as typeof import('../src/dal/export')
    const options = {
      schema: AppSchema,
      database: {
        dbFilename: `migration-${crypto.randomUUID()}.db`,
        vfs: WASQLiteVFS.IDBBatchAtomicVFS,
        enableMultiTabs: false,
        useWebWorker: false,
      },
    }
    const original = new PowerSyncDatabase(options)
    const snapshot = (transaction: NonNullable<Awaited<ReturnType<typeof original.getNextCrudTransaction>>>) =>
      transaction.crud.map(({ clientId, table, op, id, metadata, opData }) => ({
        clientId,
        table,
        op,
        id,
        metadata,
        opData,
      }))
    const beforeClose = await (async () => {
      try {
        await original.init()
        await original.execute(
          'INSERT INTO models (id, provider, name, model, url, enabled) VALUES (?, ?, ?, ?, ?, ?)',
          ['legacy', 'otari', 'Legacy', 'legacy', 'https://otari.example/api/v1', 1],
        )
        await original.execute('INSERT INTO models_secrets (id, api_key) VALUES (?, ?)', ['legacy', 'local-key'])
        await (await original.getNextCrudTransaction())!.complete()
        const db = wrapPowerSyncWithDrizzle(original, { schema: drizzleSchema }) as unknown as AnyDrizzleDatabase
        await migrateProviderConnections(db)
        return snapshot((await original.getNextCrudTransaction())!)
      } finally {
        await original.close()
      }
    })()
    const reopened = new PowerSyncDatabase(options)
    try {
      await reopened.init()
      const retry = (await reopened.getNextCrudTransaction())!
      const afterReopen = snapshot(retry)
      await retry.complete()
      const db = wrapPowerSyncWithDrizzle(reopened, { schema: drizzleSchema }) as unknown as AnyDrizzleDatabase
      await saveProviderConnection(db, {
        id: 'explicit',
        provider: 'openai',
        name: 'Explicit',
        authMethod: 'api_key',
        credentials: { apiKey: 'explicit-key' },
      })
      await updateProviderConnection(db, 'legacy-model:legacy', { name: 'Renamed' })
      const ordinary = (await reopened.getCrudBatch())!
      const backup = await exportUserData(db, { id: 'fixture', email: null })
      return {
        beforeClose,
        afterReopen,
        ordinary: ordinary.crud.map(({ table, op, id, metadata, opData }) => ({ table, op, id, metadata, opData })),
        hiddenMetadata: await reopened.getAll<{ _metadata: null }>('SELECT _metadata FROM provider_connections'),
        exported: backup.tables.provider_connections,
        credential: (await getProviderCredentials(db, 'legacy-model:legacy'))?.apiKey,
      }
    } finally {
      await reopened.close()
    }
  })
  expect(result.beforeClose).toEqual(result.afterReopen)
  expect(result.afterReopen.filter(({ table }) => table === 'provider_connections')).toEqual([
    expect.objectContaining({ id: 'legacy-model:legacy', op: 'PUT', metadata: providerConnectionMigrationMetadata }),
  ])
  expect(result.ordinary).toEqual([
    expect.objectContaining({ id: 'explicit', table: 'provider_connections', op: 'PUT', metadata: undefined }),
    expect.objectContaining({
      id: 'legacy-model:legacy',
      table: 'provider_connections',
      op: 'PATCH',
      metadata: undefined,
    }),
  ])
  for (const { opData } of [...result.afterReopen, ...result.ordinary]) {
    expect(opData).not.toHaveProperty('_metadata')
  }
  expect(result.hiddenMetadata).toEqual([{ _metadata: null }, { _metadata: null }])
  expect(result.exported).toHaveLength(2)
  for (const row of result.exported) {
    expect(row).not.toHaveProperty('_metadata')
  }
  expect(result.credential).toBe('local-key')
})
