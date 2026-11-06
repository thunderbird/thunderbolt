/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { resetAppDir } from './fs'

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
