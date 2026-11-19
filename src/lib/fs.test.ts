/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createAppDir, resetAppDir, runAppStorageOperation } from './fs'
import * as database from '@/db/database'
import { getClock } from '@/testing-library'
import { clearAuthToken, setAuthToken } from './auth-token'
import { attachmentDatabaseName, bindLocalData, openLocalData, resetLocalDataOwnerForTests } from './local-data-owner'
import * as platform from './platform'
import { clearCachedSession, setCachedSession } from './session-cache'
import { localDataKey, readLocalDataRecord as record } from '@/test-utils/local-data'
import * as path from '@tauri-apps/api/path'
import * as fs from '@tauri-apps/plugin-fs'

/**
 * An in-memory OPFS root holding the named files, listed in that order. A `held` name acts like a
 * file another tab holds open: removing it fails, as it does in Chrome and Safari.
 */
const fakeOpfsRoot = (names: string[] = [], held: string[] = []) => {
  const entries = new Set(names)
  const root = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!entries.has(name) && !options?.create) {
        throw new DOMException('not found', 'NotFoundError')
      }
      entries.add(name)
      return {}
    },
    getDirectoryHandle: async (name: string) => {
      entries.add(name)
      return {}
    },
    removeEntry: async (name: string) => {
      if (held.includes(name)) {
        throw new DOMException('Held by another tab', 'NoModificationAllowedError')
      }
      entries.delete(name)
    },
    async *entries() {
      for (const name of [...entries]) {
        yield [name, {}]
      }
    },
  }
  return { root, entries }
}

/** An IndexedDB factory recording deletes; `fails` makes each delete error. `names` are what it lists. */
const fakeIndexedDb = (fails = false, names?: string[]) => {
  const deleted: string[] = []
  const idb = {
    ...(names && { databases: async () => names.map((name) => ({ name, version: 1 })) }),
    deleteDatabase: (name: string) => {
      deleted.push(name)
      const request: { onsuccess?: () => void; onerror?: () => void; error?: Error } = { error: new Error('no') }
      queueMicrotask(() => (fails ? request.onerror?.() : request.onsuccess?.()))
      return request
    },
  }
  return { idb, deleted }
}

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

/** `root: null` is a browser without OPFS. */
const install = (
  root: ReturnType<typeof fakeOpfsRoot>['root'] | null,
  idb: ReturnType<typeof fakeIndexedDb>['idb'],
) => {
  Object.defineProperty(navigator, 'storage', {
    value: root ? { getDirectory: async () => root } : {},
    configurable: true,
  })
  Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true })
}

describe('resetAppDir', () => {
  beforeEach(() => {
    spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    // Every wipe leaves an ownership record, which would add its slot to the next test's wipe.
    localStorage.clear()
    for (const [target, key, descriptor] of [
      [navigator, 'storage', originalStorage],
      [globalThis, 'indexedDB', originalIndexedDb],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor)
      } else {
        delete (target as Record<string, unknown>)[key]
      }
    }
  })

  it('keeps ownership after a reset deadline until the actual close and wipe finish', async () => {
    const { root, entries } = fakeOpfsRoot(['old-file'])
    const { idb } = fakeIndexedDb()
    install(root, idb)
    const closing = Promise.withResolvers<void>()
    const close = spyOn(database, 'resetDatabase').mockImplementation(() => closing.promise)
    const state = { booted: false }
    try {
      const reset = resetAppDir().catch((error: unknown) => error)
      await getClock().tickAsync(30_000)
      expect(await reset).toBeInstanceOf(Error)
      const boot = runAppStorageOperation(async () => {
        state.booted = true
      })
      await Promise.resolve()
      expect(state.booted).toBe(false)
      expect(entries.has('old-file')).toBe(true)
      closing.resolve()
      await boot
      expect(state.booted).toBe(true)
      expect(entries.has('old-file')).toBe(false)
    } finally {
      closing.resolve()
      close.mockRestore()
    }
  })

  it('wipes OPFS, leaves an empty database file for the next start and deletes the IndexedDB database', async () => {
    const { root, entries } = fakeOpfsRoot(['old-file'])
    const { idb, deleted } = fakeIndexedDb()
    install(root, idb)

    await resetAppDir()

    expect(entries.has('old-file')).toBe(false)
    expect(entries.has('thunderbolt-sync.db')).toBe(true)
    expect(deleted.sort()).toEqual([':memory:', 'thunderbolt-files', 'thunderbolt-sync.db'])
  })

  describe('across every account’s database (THU-963)', () => {
    const slotA = '11111111-1111-4111-8111-111111111111'
    const orphan = '22222222-2222-4222-8222-222222222222'

    /** Once a wipe starts, the ownership record holds one new slot with no owner instead of the recorded slots. */
    const expectOnlyAnEmptySlot = () => {
      expect(Object.keys(record().slots)).toEqual([record().active])
      expect(record().slots[record().active]).toEqual({})
      expect([slotA, 'default']).not.toContain(record().active)
    }

    beforeEach(() => {
      localStorage.setItem(
        localDataKey,
        JSON.stringify({ active: slotA, slots: { default: { owner: 'user-a' }, [slotA]: { owner: 'user-b' } } }),
      )
    })

    afterEach(() => {
      resetLocalDataOwnerForTests()
      clearAuthToken()
      clearCachedSession()
      localStorage.clear()
    })

    it('fails the reset without OPFS when a database cannot be deleted, since it holds the data', async () => {
      const { idb } = fakeIndexedDb(true)
      install(null, idb)
      await expect(resetAppDir()).rejects.toThrow('Failed to delete the IndexedDB databases')
      expectOnlyAnEmptySlot()
    })

    describe('a wipe that stops partway, with B still signed in ("Clear Local Database" keeps the session)', () => {
      const slotFileA = `thunderbolt-sync-${slotA}.db`

      beforeEach(() => {
        spyOn(console, 'error').mockImplementation(() => {})
        setAuthToken('token-of-b')
        setCachedSession({ user: { id: 'user-b' }, session: { token: 'token-of-b' } })
      })

      /** The page boots again, as another tab does as soon as the ownership record changes, and B's session binds. */
      const bootAsB = async () => {
        resetLocalDataOwnerForTests()
        const filename = await openLocalData()
        bindLocalData('user-b')
        return filename
      }

      it('deletes A’s IndexedDB database, and never hands it to B, when an OPFS file another tab holds stops the wipe', async () => {
        // A's database predates OPFS on this install; B's slot is an OPFS file B's second tab holds.
        const { root } = fakeOpfsRoot([`${slotFileA}-wal`, slotFileA], [`${slotFileA}-wal`])
        const { idb, deleted } = fakeIndexedDb(false, ['thunderbolt-sync.db'])
        install(root, idb)

        await expect(resetAppDir()).rejects.toThrow('Failed to remove OPFS entries')
        expect(deleted).toContain('thunderbolt-sync.db')

        expect(await bootAsB()).not.toBe('thunderbolt-sync.db')
        expect(record().slots.default).toBeUndefined()
      })

      it('removes the OPFS files listed after a held one, and never hands A’s database to B (WebKit’s order)', async () => {
        const { root, entries } = fakeOpfsRoot([slotFileA, 'thunderbolt-sync.db'], [slotFileA])
        const { idb } = fakeIndexedDb(false, [])
        install(root, idb)

        await expect(resetAppDir()).rejects.toThrow('Failed to remove OPFS entries')
        expect([...entries]).toEqual([slotFileA])

        expect(await bootAsB()).not.toBe('thunderbolt-sync.db')
        expect(record().slots.default).toBeUndefined()
      })
    })

    it('deletes every slot’s attachment store when a file another tab holds stops the OPFS wipe', async () => {
      spyOn(console, 'error').mockImplementation(() => {})
      // B's slot is an OPFS file B's second tab holds; A's default slot has its attachment store.
      const heldFile = `thunderbolt-sync-${slotA}.db`
      const { root } = fakeOpfsRoot(['thunderbolt-sync.db', heldFile], [heldFile])
      const { idb, deleted } = fakeIndexedDb(false, ['thunderbolt-files', `thunderbolt-files-${slotA}`])
      install(root, idb)

      await expect(resetAppDir()).rejects.toThrow('Failed to remove OPFS entries')
      expect(deleted).toEqual(expect.arrayContaining(['thunderbolt-files', `thunderbolt-files-${slotA}`]))

      // "Delete data from device" goes on: the token and cached session go, then all of localStorage.
      localStorage.clear()
      resetLocalDataOwnerForTests()
      await openLocalData()
      expect(deleted).toContain(attachmentDatabaseName())
    })

    it('deletes every app IndexedDB database and attachment store, nothing else, and forgets the slots', async () => {
      const { idb, deleted } = fakeIndexedDb(false, [
        ':memory:',
        `thunderbolt-sync-${orphan}.db`,
        `thunderbolt-files-${orphan}`,
        'thunderbolt-keys',
        'thunderbolt-sync-evil.db',
        'thunderbolt-files-evil',
      ])
      install(null, idb)

      await resetAppDir()

      expect(deleted.sort()).toEqual(
        [
          ':memory:',
          'thunderbolt-sync.db',
          'thunderbolt-files',
          `thunderbolt-sync-${slotA}.db`,
          `thunderbolt-files-${slotA}`,
          `thunderbolt-sync-${orphan}.db`,
          `thunderbolt-files-${orphan}`,
        ].sort(),
      )
      expectOnlyAnEmptySlot()
    })
  })

  it('still completes when the IndexedDB delete fails', async () => {
    const { root, entries } = fakeOpfsRoot()
    const { idb } = fakeIndexedDb(true)
    install(root, idb)
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})

    await resetAppDir()

    expect(entries.has('thunderbolt-sync.db')).toBe(true)
    expect(consoleError).toHaveBeenCalled()
  })
})

describe('app directory creation', () => {
  it('owns native module references per call, including concurrent calls and retry after failure', async () => {
    const native = spyOn(platform, 'isTauri').mockReturnValue(true)
    const appDataDir = spyOn(path, 'appDataDir').mockResolvedValue('/app-data')
    const mkdir = spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue()
    try {
      const results = await Promise.allSettled([createAppDir(), createAppDir()])
      expect(results).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ message: 'permission denied' }) },
        { status: 'fulfilled', value: '/app-data' },
      ])
      await expect(createAppDir()).resolves.toBe('/app-data')
      expect(mkdir).toHaveBeenCalledTimes(3)
    } finally {
      native.mockRestore()
      appDataDir.mockRestore()
      mkdir.mockRestore()
    }
  })
})
