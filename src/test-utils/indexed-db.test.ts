/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'

import { restoreIndexedDb, stubIndexedDb } from './indexed-db'

const hasIndexedDb = () => 'indexedDB' in globalThis

describe('stubIndexedDb / restoreIndexedDb', () => {
  // happy-dom ships no IndexedDB, so "absent" is the real baseline — assert
  // against it explicitly rather than trusting whatever ran before this file.
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'indexedDB')
  })

  it('installs an openable factory and removes it again', async () => {
    stubIndexedDb()
    const opened = await new Promise<boolean>((resolve) => {
      const request = globalThis.indexedDB.open('probe')
      request.onsuccess = () => resolve(true)
      request.onerror = () => resolve(false)
    })
    expect(opened).toBe(true)
    restoreIndexedDb()
    // Deleted, not set to undefined: code reading the bare global must still
    // see a ReferenceError, which is what the boot pre-flight relies on.
    expect(hasIndexedDb()).toBe(false)
  })

  it('restores a pre-existing global rather than deleting it', () => {
    const original = { marker: 'real' } as unknown as IDBFactory
    Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true, writable: true })
    stubIndexedDb()
    expect(globalThis.indexedDB).not.toBe(original)
    restoreIndexedDb()
    expect(globalThis.indexedDB).toBe(original)
    Reflect.deleteProperty(globalThis, 'indexedDB')
  })

  it('does not restore a stub over a stub when nested', () => {
    stubIndexedDb()
    stubIndexedDb()
    restoreIndexedDb()
    expect(hasIndexedDb()).toBe(false)
  })

  it('leaves the global alone when restore runs without a stub', () => {
    restoreIndexedDb()
    expect(hasIndexedDb()).toBe(false)
  })
})
