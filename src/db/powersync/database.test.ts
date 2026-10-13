/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import type { AbstractPowerSyncDatabase, QueryResult } from '@powersync/common'

const { getPowerSyncDatabaseConfig, getPowerSyncOptions, waitForOwnDeviceRow } = await import('./database')

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
    it('returns database with dbFilename and schema', () => {
      const options = getPowerSyncOptions('opfs/thunderbolt-sync.db', 'default')
      expect(options.database).toEqual({ dbFilename: 'thunderbolt-sync.db' })
      expect(options.schema).toBeDefined()
    })

    it('extracts dbFilename from path with slashes', () => {
      const options = getPowerSyncOptions('foo/bar/baz.db', 'default')
      expect(options.database).toEqual({ dbFilename: 'baz.db' })
    })

    it('uses path as dbFilename when no slashes', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'default')
      expect(options.database).toEqual({ dbFilename: 'thunderbolt.db' })
    })

    it('does not include flags', () => {
      const options = getPowerSyncOptions('thunderbolt.db')
      expect(options).not.toHaveProperty('flags')
    })

    it('always includes custom SharedWorker and transformers', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'default')
      expect(options).toHaveProperty('sync')
      expect(options.sync).toHaveProperty('worker')
      expect(options).toHaveProperty('transformers')
      expect(options.transformers).toHaveLength(1)
    })
  })

  describe('safari-tauri config', () => {
    it('returns WASQLiteOpenFactory with OPFSCoopSyncVFS and explicit workers', () => {
      const options = getPowerSyncOptions('opfs/thunderbolt-sync.db', 'safari-tauri')
      expect(options.database).toBeInstanceOf(WASQLiteOpenFactory)
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.dbFilename).toBe('thunderbolt-sync.db')
      expect(factory.waOptions.vfs).toBeDefined()
      expect(factory.waOptions.worker).toBe('/@powersync/worker/WASQLiteDB.umd.js')
      expect(factory.waOptions.flags?.enableMultiTabs).toBe(false)
    })

    it('enables multi-tab sync selection and provides a dedicated sync worker factory', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'safari-tauri')
      // PowerSyncDatabase-level enableMultiTabs: true selects the off-thread
      // SharedWebStreamingSyncImplementation; the DB factory keeps its own false.
      expect('flags' in options && options.flags).toEqual({ enableMultiTabs: true })
      expect(typeof (options.sync as { worker: () => unknown }).worker).toBe('function')
    })

    it('always includes transformers', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'safari-tauri')
      expect(options).toHaveProperty('transformers')
      expect(options.transformers).toHaveLength(1)
    })

    it('extracts dbFilename from path correctly', () => {
      const options = getPowerSyncOptions('foo/bar/thunderbolt-sync.db', 'safari-tauri')
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.dbFilename).toBe('thunderbolt-sync.db')
    })

    it('uses OPFSCoopSyncVFS when OPFS is available (default)', () => {
      const options = getPowerSyncOptions('thunderbolt-sync.db', 'safari-tauri')
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.vfs).toBe(WASQLiteVFS.OPFSCoopSyncVFS)
    })

    it('falls back to IDBBatchAtomicVFS when OPFS is unavailable', () => {
      const options = getPowerSyncOptions('thunderbolt-sync.db', 'safari-tauri', false)
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.vfs).toBe(WASQLiteVFS.IDBBatchAtomicVFS)
    })

    it('keeps Tauri-safe worker wiring in the OPFS-unavailable fallback', () => {
      const options = getPowerSyncOptions('thunderbolt-sync.db', 'safari-tauri', false)
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.worker).toBe('/@powersync/worker/WASQLiteDB.umd.js')
      expect(factory.waOptions.flags?.enableMultiTabs).toBe(false)
      expect('flags' in options && options.flags).toEqual({ enableMultiTabs: true })
      expect(typeof (options.sync as { worker: () => unknown }).worker).toBe('function')
    })
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
          yield { rows: { length } } as QueryResult
        }
      },
    }) as unknown as AbstractPowerSyncDatabase

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
