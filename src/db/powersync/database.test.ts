/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { PowerSyncDatabaseImpl } from './database'
import { WASQLiteVFS } from '@powersync/web'
import type { CommonPowerSyncDatabase, QueryResult } from '@powersync/common'

const { getPowerSyncDatabaseConfig, getPowerSyncOptions, shouldUseOpfs, waitForOwnDeviceRow } =
  await import('./database')

describe('getPowerSyncDatabaseConfig', () => {
  it('returns default for web + Chrome', () => {
    expect(getPowerSyncDatabaseConfig('web', 'chrome')).toBe('default')
  })

  it('returns default for web + Edge', () => {
    expect(getPowerSyncDatabaseConfig('web', 'edge')).toBe('default')
  })

  it('returns default for web + Firefox', () => {
    expect(getPowerSyncDatabaseConfig('web', 'firefox')).toBe('default')
  })

  it('returns safari-tauri for web + Safari', () => {
    expect(getPowerSyncDatabaseConfig('web', 'safari')).toBe('safari-tauri')
  })

  it('returns safari-tauri for Tauri iOS', () => {
    expect(getPowerSyncDatabaseConfig('ios', 'unknown')).toBe('safari-tauri')
  })

  it('returns safari-tauri for Tauri macOS', () => {
    expect(getPowerSyncDatabaseConfig('macos', 'unknown')).toBe('safari-tauri')
  })

  it('returns safari-tauri for Tauri Android', () => {
    expect(getPowerSyncDatabaseConfig('android', 'unknown')).toBe('safari-tauri')
  })

  it('returns default for web + unknown browser (non-Safari)', () => {
    expect(getPowerSyncDatabaseConfig('web', 'unknown')).toBe('default')
  })
})

describe('getPowerSyncOptions', () => {
  describe('default config (web + non-Safari)', () => {
    it('stores the database on OPFS with OPFSCoopSyncVFS', () => {
      const options = getPowerSyncOptions('opfs/thunderbolt-sync.db', 'default', true)
      expect(options.database).toEqual({ dbFilename: 'thunderbolt-sync.db', vfs: WASQLiteVFS.OPFSCoopSyncVFS })
      expect(options.schema).toBeDefined()
    })

    it('keeps IndexedDB when OPFS is not used', () => {
      const options = getPowerSyncOptions('opfs/thunderbolt-sync.db', 'default', false)
      expect(options.database).toEqual({ dbFilename: 'thunderbolt-sync.db', vfs: WASQLiteVFS.IDBBatchAtomicVFS })
    })

    it('extracts dbFilename from path with slashes', () => {
      const options = getPowerSyncOptions('foo/bar/baz.db', 'default', true)
      expect(options.database.dbFilename).toBe('baz.db')
    })

    it('uses path as dbFilename when no slashes', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'default', true)
      expect(options.database.dbFilename).toBe('thunderbolt.db')
    })

    it('maps the :memory: no-OPFS sentinel to powerSyncDbFilename instead of literal :memory:', () => {
      const options = getPowerSyncOptions(':memory:', 'default', false)
      expect(options.database).toEqual({ dbFilename: 'thunderbolt-sync.db', vfs: WASQLiteVFS.IDBBatchAtomicVFS })
    })

    it('does not include flags', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'default', true)
      expect(options).not.toHaveProperty('flags')
    })

    it('always includes the custom SharedWorker', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'default', true)
      expect(options).toHaveProperty('sync')
      expect(options.sync).toHaveProperty('worker')
    })
  })

  describe('safari-tauri config', () => {
    type SafariTauriDatabase = { dbFilename: string; vfs: WASQLiteVFS; enableMultiTabs: boolean; worker: string }
    const databaseOf = (options: ReturnType<typeof getPowerSyncOptions>) => options.database as SafariTauriDatabase

    it("opens OPFSCoopSyncVFS in PowerSync's prebuilt worker from an absolute path (tauri:// safe)", () => {
      const database = databaseOf(getPowerSyncOptions('opfs/thunderbolt-sync.db', 'safari-tauri', true))
      expect(database.dbFilename).toBe('thunderbolt-sync.db')
      expect(database.vfs).toBe(WASQLiteVFS.OPFSCoopSyncVFS)
      expect(database.worker).toBe('/@powersync/worker.js')
    })

    it('enables multi-tab sync selection and provides a dedicated sync worker factory', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'safari-tauri', true)
      // enableMultiTabs: true selects the off-thread SharedWebStreamingSyncImplementation.
      expect(databaseOf(options).enableMultiTabs).toBe(true)
      expect(options).not.toHaveProperty('flags')
      expect(typeof (options.sync as { worker: () => unknown }).worker).toBe('function')
    })

    it('points the database worker at a file the copy-assets step publishes', () => {
      // vite.config.ts copies `@powersync/web/dist/worker` to `/@powersync/`.
      const { worker } = databaseOf(getPowerSyncOptions('thunderbolt-sync.db', 'safari-tauri', true))
      const workerDir = resolve(import.meta.dir, '../../../node_modules/@powersync/web/dist/worker')
      expect(existsSync(resolve(workerDir, worker.replace('/@powersync/', '')))).toBe(true)
    })

    it('extracts dbFilename from path correctly', () => {
      const options = getPowerSyncOptions('foo/bar/thunderbolt-sync.db', 'safari-tauri', true)
      expect(databaseOf(options).dbFilename).toBe('thunderbolt-sync.db')
    })

    it('falls back to IDBBatchAtomicVFS, syncing in the tab, when OPFS is unavailable', () => {
      // With multi-tab on, PowerSync would open IndexedDB in a SharedWorker.
      const database = databaseOf(getPowerSyncOptions('thunderbolt-sync.db', 'safari-tauri', false))
      expect(database.vfs).toBe(WASQLiteVFS.IDBBatchAtomicVFS)
      expect(database.enableMultiTabs).toBe(false)
      expect(database.worker).toBe('/@powersync/worker.js')
    })
  })

  it.each([
    ['default', true],
    ['default', false],
    ['safari-tauri', true],
    ['safari-tauri', false],
  ] as const)('keeps %s database options cloneable (opfs: %p)', (config, useOpfs) => {
    // PowerSync posts the database options to the sync worker; a function in them fails sync init.
    const options = getPowerSyncOptions('thunderbolt-sync.db', config, useOpfs)
    expect(() => structuredClone(options.database)).not.toThrow()
  })
})

describe('shouldUseOpfs', () => {
  const idbWith = (...names: string[]) => ({ databases: async () => names.map((name) => ({ name, version: 1 })) })
  const opfsWith = (...names: string[]) => ({
    getFileHandle: async (name: string) => {
      if (!names.includes(name)) {
        throw new DOMException('not found', 'NotFoundError')
      }
      return {} as FileSystemFileHandle
    },
  })
  const path = 'app/thunderbolt-sync.db'

  it('uses OPFS on a default-config device with no database yet', async () => {
    expect(await shouldUseOpfs(path, 'default', { opfsRoot: opfsWith(), idb: idbWith('thunderbolt-keys') })).toBe(true)
  })

  it('keeps a default-config device whose data already lives in IndexedDB there', async () => {
    const storage = { opfsRoot: opfsWith(), idb: idbWith('thunderbolt-sync.db') }
    expect(await shouldUseOpfs(path, 'default', storage)).toBe(false)
  })

  it('uses OPFS once its database file exists, even while the IndexedDB database lingers', async () => {
    const storage = { opfsRoot: opfsWith('thunderbolt-sync.db'), idb: idbWith('thunderbolt-sync.db') }
    expect(await shouldUseOpfs(path, 'default', storage)).toBe(true)
  })

  it('keeps IndexedDB when the browser cannot list its databases', async () => {
    const storage = { opfsRoot: opfsWith(), idb: {} as Pick<IDBFactory, 'databases'> }
    expect(await shouldUseOpfs(path, 'default', storage)).toBe(false)
  })

  it('never uses OPFS when it is unavailable', async () => {
    expect(await shouldUseOpfs(':memory:', 'default')).toBe(false)
    expect(await shouldUseOpfs(':memory:', 'safari-tauri')).toBe(false)
  })

  it('always uses OPFS on safari-tauri when available, whatever IndexedDB holds', async () => {
    expect(await shouldUseOpfs(path, 'safari-tauri', { idb: idbWith('thunderbolt-sync.db') })).toBe(true)
  })
})

describe('waitForOwnDeviceRow', () => {
  type Reads = { params?: unknown[]; count: number }

  afterEach(() => {
    localStorage.removeItem('thunderbolt_device_id')
  })

  const fakePowerSync = (rowCounts: number[], reads: Reads) =>
    ({
      watch: async function* (_sql: string, params: unknown[]) {
        reads.params = params
        for (const length of rowCounts) {
          reads.count++
          yield { array: Array.from({ length }, () => ({})) } as QueryResult
        }
      },
    }) as unknown as CommonPowerSyncDatabase

  it("waits past empty results for this device's row", async () => {
    localStorage.setItem('thunderbolt_device_id', 'device-1')
    const reads: Reads = { count: 0 }

    await waitForOwnDeviceRow(fakePowerSync([0, 0, 1, 1], reads), new AbortController().signal)

    expect(reads).toEqual({ params: ['device-1'], count: 3 })
  })

  it('returns when the watch ends without the row', async () => {
    const reads: Reads = { count: 0 }

    await waitForOwnDeviceRow(fakePowerSync([0], reads), new AbortController().signal)

    expect(reads.count).toBe(1)
  })
})

describe('PowerSync connection ownership', () => {
  const makeDatabase = () => {
    const connecting = Promise.withResolvers<void>()
    const disconnecting = Promise.withResolvers<void>()
    const events: string[] = []
    const powerSync = {
      currentStatus: { hasSynced: true },
      registerListener: () => () => {},
      connect: mock(async () => {
        events.push('connect')
        await connecting.promise
      }),
      disconnect: mock(async () => {
        events.push('disconnect')
        await disconnecting.promise
      }),
      disconnectAndClear: mock(async () => {
        events.push('clear')
      }),
      close: mock(async () => {
        events.push('close')
      }),
    }
    const database = new PowerSyncDatabaseImpl()
    Object.assign(database, { powerSync, _db: {} })
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true)
    return { database, connecting, disconnecting, powerSync, events }
  }

  afterEach(() => useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false))

  it('coalesces overlapping connects before native connect has settled', async () => {
    const { database, connecting, powerSync } = makeDatabase()
    const first = database.connectToSync()
    const second = database.connectToSync()
    await Promise.resolve()
    expect(powerSync.connect).toHaveBeenCalledTimes(1)
    connecting.resolve()
    await Promise.all([first, second])
    expect(powerSync.connect).toHaveBeenCalledTimes(1)
    await database.close()
    expect(database.isConnected).toBe(false)
  })

  it('orders disable then enable while the native disconnect is pending', async () => {
    const { database, connecting, disconnecting, events } = makeDatabase()
    connecting.resolve()
    await database.connectToSync()
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
    const disabling = database.disconnectFromSync()
    await Promise.resolve()
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true)
    const enabling = database.connectToSync()
    disconnecting.resolve()
    await Promise.all([disabling, enabling])
    expect(events).toEqual(['connect', 'disconnect', 'connect'])
    expect(database.isConnected).toBe(true)
    await database.close()
  })

  it('drains startup before closing and cannot reconnect the disposed database', async () => {
    const { database, connecting, events } = makeDatabase()
    const opening = database.connectToSync()
    await Promise.resolve()
    const closing = database.close()
    expect(events).toEqual(['connect'])
    connecting.resolve()
    await Promise.all([opening, closing])
    await database.connectToSync()
    expect(events).toEqual(['connect', 'clear', 'close'])
    expect(database.isConnected).toBe(false)
  })

  it('coalesces reconnect requests while a native disconnect is in flight', async () => {
    const { database, connecting, disconnecting, events } = makeDatabase()
    connecting.resolve()
    await database.connectToSync()
    const first = database.reconnect()
    await Promise.resolve()
    await database.reconnect()
    expect(events).toEqual(['connect', 'disconnect'])
    disconnecting.resolve()
    await first
    expect(events).toEqual(['connect', 'disconnect', 'connect'])
    expect(database.isConnected).toBe(true)
    await database.close()
  })

  it('disconnects when sync is disabled while native connect is pending', async () => {
    const { database, connecting, disconnecting, events } = makeDatabase()
    const opening = database.connectToSync()
    await Promise.resolve()
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
    const disabling = database.disconnectFromSync()
    connecting.resolve()
    disconnecting.resolve()
    await Promise.all([opening, disabling])
    expect(events).toEqual(['connect', 'disconnect'])
    expect(database.isConnected).toBe(false)
    await database.close()
  })

  it('does not poison the queue when native cleanup rejects', async () => {
    const { database, powerSync, events } = makeDatabase()
    powerSync.disconnectAndClear.mockRejectedValueOnce(new Error('storage busy'))
    await expect(database.close()).rejects.toThrow('storage busy')
    await database.close()
    expect(events).toEqual(['clear', 'close'])
    expect(database.powerSyncInstance).toBeNull()
  })
})
