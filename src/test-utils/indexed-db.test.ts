/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { restoreIndexedDb, stubIndexedDb } from './indexed-db'

const hasIndexedDb = () => 'indexedDB' in globalThis

/** happy-dom ships no IndexedDB, so "absent" is the real baseline. Reset to it on
 *  both sides: an assertion that fails mid-test would otherwise leave the global
 *  and the helper's snapshot dirty for whatever the shuffle runs next. */
const resetToAbsent = () => {
  restoreIndexedDb()
  Reflect.deleteProperty(globalThis, 'indexedDB')
}

const openStub = async () =>
  await new Promise<IDBDatabase | null>((resolve) => {
    const request = globalThis.indexedDB.open('probe')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })

describe('stubIndexedDb / restoreIndexedDb', () => {
  beforeEach(resetToAbsent)
  afterEach(resetToAbsent)

  it('installs an openable factory and removes it again', async () => {
    stubIndexedDb()
    expect(await openStub()).not.toBeNull()
    restoreIndexedDb()
    // Deleted, not set to `undefined`: `@/crypto/key-storage` reads the bare
    // `indexedDB` global, so absence has to stay a ReferenceError rather than
    // becoming a TypeError on `undefined.open`. (The boot pre-flight reads
    // `globalThis.indexedDB` instead and treats both the same.)
    expect(hasIndexedDb()).toBe(false)
  })

  it('exposes no transaction, so key-storage calls fail loudly instead of hanging', async () => {
    stubIndexedDb()
    const db = await openStub()
    // key-storage's reads and writes wait on `transaction.oncomplete`/`onsuccess`.
    // A richer fake that never fires those events hangs the caller to the test
    // timeout; leaving `transaction` off makes the same call throw immediately.
    expect(db).not.toBeNull()
    expect('transaction' in (db as IDBDatabase)).toBe(false)
  })

  it('restores a pre-existing global rather than deleting it', async () => {
    // Reuse a stub as the stand-in "real" factory so the test needs no cast.
    stubIndexedDb()
    const original = globalThis.indexedDB
    restoreIndexedDb()
    Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true, writable: true })

    stubIndexedDb()
    expect(globalThis.indexedDB).not.toBe(original)
    restoreIndexedDb()
    expect(globalThis.indexedDB).toBe(original)
  })

  it('restores the original global after repeated stubbing, never a stub', () => {
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
