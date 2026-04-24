import { describe, expect, it } from 'bun:test'
import { WASQLiteOpenFactory } from '@powersync/web'

const { getPowerSyncDatabaseConfig, getPowerSyncOptions } = await import('./database')

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

    it('includes flags and sync with explicit worker paths', () => {
      const options = getPowerSyncOptions('thunderbolt.db', 'safari-tauri')
      expect('flags' in options && options.flags).toEqual({ enableMultiTabs: false })
      expect(options.sync).toEqual({ worker: '/@powersync/worker/SharedSyncImplementation.umd.js' })
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
  })
})
