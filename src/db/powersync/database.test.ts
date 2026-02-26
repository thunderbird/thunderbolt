import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockGetPlatform = mock((): 'web' | 'ios' | 'macos' | 'android' => 'web')
const mockGetWebBrowser = mock((): 'chrome' | 'edge' | 'firefox' | 'safari' | 'unknown' => 'chrome')

mock.module('@/lib/platform', () => ({
  getPlatform: () => mockGetPlatform(),
  getWebBrowser: () => mockGetWebBrowser(),
}))

import { getPowerSyncDatabaseConfig, getPowerSyncOptions } from './database'
import { WASQLiteOpenFactory } from '@powersync/web'

describe('getPowerSyncDatabaseConfig', () => {
  beforeEach(() => {
    mockGetPlatform.mockReset()
    mockGetWebBrowser.mockReset()
  })

  afterEach(() => {
    mockGetPlatform.mockRestore?.()
    mockGetWebBrowser.mockRestore?.()
  })

  it('returns default for web + Chrome', () => {
    mockGetPlatform.mockReturnValue('web' as const)
    mockGetWebBrowser.mockReturnValue('chrome' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('default')
  })

  it('returns default for web + Edge', () => {
    mockGetPlatform.mockReturnValue('web' as const)
    mockGetWebBrowser.mockReturnValue('edge' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('default')
  })

  it('returns default for web + Firefox', () => {
    mockGetPlatform.mockReturnValue('web' as const)
    mockGetWebBrowser.mockReturnValue('firefox' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('default')
  })

  it('returns safari-tauri for web + Safari', () => {
    mockGetPlatform.mockReturnValue('web' as const)
    mockGetWebBrowser.mockReturnValue('safari' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('safari-tauri')
  })

  it('returns safari-tauri for Tauri iOS', () => {
    mockGetPlatform.mockReturnValue('ios' as const)
    mockGetWebBrowser.mockReturnValue('unknown' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('safari-tauri')
  })

  it('returns safari-tauri for Tauri macOS', () => {
    mockGetPlatform.mockReturnValue('macos' as const)
    mockGetWebBrowser.mockReturnValue('unknown' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('safari-tauri')
  })

  it('returns safari-tauri for Tauri Android', () => {
    mockGetPlatform.mockReturnValue('android' as const)
    mockGetWebBrowser.mockReturnValue('unknown' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('safari-tauri')
  })

  it('returns default for web + unknown browser (non-Safari)', () => {
    mockGetPlatform.mockReturnValue('web' as const)
    mockGetWebBrowser.mockReturnValue('unknown' as const)
    expect(getPowerSyncDatabaseConfig()).toBe('default')
  })
})

describe('getPowerSyncOptions', () => {
  beforeEach(() => {
    mockGetPlatform.mockReset()
    mockGetWebBrowser.mockReset()
  })

  describe('default config (web + non-Safari)', () => {
    beforeEach(() => {
      mockGetPlatform.mockReturnValue('web' as const)
      mockGetWebBrowser.mockReturnValue('chrome' as const)
    })

    it('returns database with dbFilename and schema', () => {
      const options = getPowerSyncOptions('opfs/thunderbolt-sync.db')
      expect(options.database).toEqual({ dbFilename: 'thunderbolt-sync.db' })
      expect(options.schema).toBeDefined()
    })

    it('extracts dbFilename from path with slashes', () => {
      const options = getPowerSyncOptions('foo/bar/baz.db')
      expect(options.database).toEqual({ dbFilename: 'baz.db' })
    })

    it('uses path as dbFilename when no slashes', () => {
      const options = getPowerSyncOptions('thunderbolt.db')
      expect(options.database).toEqual({ dbFilename: 'thunderbolt.db' })
    })

    it('does not include flags or sync', () => {
      const options = getPowerSyncOptions('thunderbolt.db')
      expect(options).not.toHaveProperty('flags')
      expect(options).not.toHaveProperty('sync')
    })
  })

  describe('safari-tauri config', () => {
    beforeEach(() => {
      mockGetPlatform.mockReturnValue('ios' as const)
      mockGetWebBrowser.mockReturnValue('unknown' as const)
    })

    it('returns WASQLiteOpenFactory with OPFSCoopSyncVFS and explicit workers', () => {
      const options = getPowerSyncOptions('opfs/thunderbolt-sync.db')
      expect(options.database).toBeInstanceOf(WASQLiteOpenFactory)
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.dbFilename).toBe('thunderbolt-sync.db')
      expect(factory.waOptions.vfs).toBeDefined()
      expect(factory.waOptions.worker).toBe('/@powersync/worker/WASQLiteDB.umd.js')
      expect(factory.waOptions.flags?.enableMultiTabs).toBe(false)
    })

    it('includes flags and sync with explicit worker paths', () => {
      const options = getPowerSyncOptions('thunderbolt.db')
      expect(options.flags).toEqual({ enableMultiTabs: false })
      expect(options.sync).toEqual({ worker: '/@powersync/worker/SharedSyncImplementation.umd.js' })
    })

    it('extracts dbFilename from path correctly', () => {
      const options = getPowerSyncOptions('foo/bar/thunderbolt-sync.db')
      const factory = options.database as WASQLiteOpenFactory
      expect(factory.waOptions.dbFilename).toBe('thunderbolt-sync.db')
    })
  })
})
