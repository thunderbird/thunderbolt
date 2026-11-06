/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createAppDir, resetAppDir, runAppStorageOperation } from './fs'
import * as database from '@/db/database'
import { getClock } from '@/testing-library'
import * as platform from './platform'
import * as path from '@tauri-apps/api/path'
import * as fs from '@tauri-apps/plugin-fs'

/** An in-memory OPFS root holding the named files. */
const fakeOpfsRoot = (...names: string[]) => {
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

/** An IndexedDB factory recording deletes; `fails` makes each delete error. */
const fakeIndexedDb = (fails = false) => {
  const deleted: string[] = []
  const idb = {
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

const install = (root: object, idb: object) => {
  Object.defineProperty(navigator, 'storage', { value: { getDirectory: async () => root }, configurable: true })
  Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true })
}

describe('resetAppDir', () => {
  beforeEach(() => {
    spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
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
    const { root, entries } = fakeOpfsRoot('old-file')
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
    const { root, entries } = fakeOpfsRoot('old-file')
    const { idb, deleted } = fakeIndexedDb()
    install(root, idb)

    await resetAppDir()

    expect(entries.has('old-file')).toBe(false)
    expect(entries.has('thunderbolt-sync.db')).toBe(true)
    expect(deleted).toEqual(['thunderbolt-sync.db'])
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
