/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { type IdbBackend, type KeyEntry, migrateEncryptionKeysIfNeeded } from './indexeddb-migration'

const serverId = '00000000-0000-0000-0000-00000000abcd'
const legacyDbName = 'thunderbolt-keys'
const namespacedDbName = (id: string): string => `thunderbolt-keys__${id}`

type Op = { kind: 'read' | 'write'; dbName: string }

/** In-memory IDB stand-in. Each DB is a Map<id, value> on the 'keys' store. */
const makeFakeBackend = (
  initial: Record<string, Record<string, unknown>> = {},
): { backend: IdbBackend; dbs: Map<string, Map<string, unknown>>; ops: Op[] } => {
  const dbs = new Map<string, Map<string, unknown>>()
  for (const [name, entries] of Object.entries(initial)) {
    dbs.set(name, new Map(Object.entries(entries)))
  }
  const ops: Op[] = []
  const backend: IdbBackend = {
    readKeyEntries: async (dbName) => {
      ops.push({ kind: 'read', dbName })
      const store = dbs.get(dbName)
      if (!store) {
        return []
      }
      return Array.from(store.entries()).map(([id, value]) => ({ id, value }))
    },
    writeKeyEntriesIfMissing: async (dbName, entries) => {
      ops.push({ kind: 'write', dbName })
      let store = dbs.get(dbName)
      if (!store) {
        store = new Map()
        dbs.set(dbName, store)
      }
      let written = 0
      for (const entry of entries) {
        if (store.has(entry.id)) {
          continue
        }
        store.set(entry.id, entry.value)
        written += 1
      }
      return written
    },
  }
  return { backend, dbs, ops }
}

const legacyKeys: Record<string, string> = {
  thunderbolt_private_key: 'priv',
  thunderbolt_public_key: 'pub',
  thunderbolt_mlkem_public_key: 'mlkem-pub',
  thunderbolt_mlkem_secret_key: 'mlkem-sec',
  thunderbolt_ck: 'content-key',
}

describe('migrateEncryptionKeysIfNeeded', () => {
  it('copies all 5 legacy key-store entries into the namespaced DB and leaves the legacy DB intact', async () => {
    const { backend, dbs } = makeFakeBackend({ [legacyDbName]: legacyKeys })

    const result = await migrateEncryptionKeysIfNeeded(serverId, backend)

    expect(result).toEqual({ migrated: true, entryCount: 5 })
    // Legacy DB is preserved untouched for rollback safety — see
    // indexeddb-migration.ts.
    expect(dbs.has(legacyDbName)).toBe(true)
    expect(Object.fromEntries(dbs.get(legacyDbName)!)).toEqual(legacyKeys)
    const newStore = dbs.get(namespacedDbName(serverId))
    expect(newStore).toBeDefined()
    expect(Object.fromEntries(newStore!)).toEqual(legacyKeys)
  })

  it('is a no-op when the legacy DB has no entries', async () => {
    // No legacy DB at all (fresh install / already migrated).
    const { backend, dbs, ops } = makeFakeBackend({})

    const result = await migrateEncryptionKeysIfNeeded(serverId, backend)

    expect(result).toEqual({ migrated: false, entryCount: 0 })
    expect(dbs.has(namespacedDbName(serverId))).toBe(false)
    // Read happens; no write, no delete.
    expect(ops.find((o) => o.kind === 'write')).toBeUndefined()
  })

  it('skips entries already present in the new DB so workspaces-build keys win', async () => {
    // Workspaces build already wrote its own private key (e.g. user enrolled
    // E2EE on the new build before realising they had legacy state). That key
    // is what the BE currently knows about — preserve it.
    const { backend, dbs } = makeFakeBackend({
      [legacyDbName]: legacyKeys,
      [namespacedDbName(serverId)]: { thunderbolt_private_key: 'new-priv' },
    })

    const result = await migrateEncryptionKeysIfNeeded(serverId, backend)

    // 5 legacy entries; 1 already in new; 4 actually written.
    expect(result).toEqual({ migrated: true, entryCount: 4 })
    const newStore = dbs.get(namespacedDbName(serverId))!
    expect(newStore.get('thunderbolt_private_key')).toBe('new-priv')
    expect(newStore.get('thunderbolt_public_key')).toBe('pub')
    expect(newStore.size).toBe(5)
    // Legacy DB is still intact.
    expect(dbs.has(legacyDbName)).toBe(true)
  })

  it('reports migrated=false when every legacy entry was already in the new DB', async () => {
    // Idempotent re-run: migration already completed once, but the boot order
    // somehow caused us back into this function. New DB has all the keys; we
    // skip every write. Legacy DB stays in place either way.
    const { backend, dbs } = makeFakeBackend({
      [legacyDbName]: legacyKeys,
      [namespacedDbName(serverId)]: legacyKeys,
    })

    const result = await migrateEncryptionKeysIfNeeded(serverId, backend)

    expect(result).toEqual({ migrated: false, entryCount: 0 })
    expect(dbs.has(legacyDbName)).toBe(true)
  })

  it('orders ops: read legacy → write namespaced', async () => {
    const { backend, ops } = makeFakeBackend({ [legacyDbName]: legacyKeys })

    await migrateEncryptionKeysIfNeeded(serverId, backend)

    expect(ops).toEqual([
      { kind: 'read', dbName: legacyDbName },
      { kind: 'write', dbName: namespacedDbName(serverId) },
    ])
  })

  it('does not write to the namespaced DB at all when legacy is empty', async () => {
    const { backend, ops } = makeFakeBackend({})

    await migrateEncryptionKeysIfNeeded(serverId, backend)

    expect(ops.find((o) => o.kind === 'write')).toBeUndefined()
  })

  it('namespaces under the given serverId — running against another server still reads the same legacy DB', async () => {
    const serverA = '00000000-0000-0000-0000-00000000000a'
    const serverB = '00000000-0000-0000-0000-00000000000b'
    const { backend, dbs } = makeFakeBackend({ [legacyDbName]: legacyKeys })

    const resultA = await migrateEncryptionKeysIfNeeded(serverA, backend)
    expect(resultA.migrated).toBe(true)
    expect(dbs.has(namespacedDbName(serverA))).toBe(true)

    // Legacy DB still around → server B also gets a copy. (E2EE keys aren't
    // server-scoped in the legacy world; each per-server namespace can hold a
    // legitimate copy, and the per-server BE controls device approval.)
    const resultB = await migrateEncryptionKeysIfNeeded(serverB, backend)
    expect(resultB).toEqual({ migrated: true, entryCount: 5 })
    expect(dbs.has(namespacedDbName(serverB))).toBe(true)
    expect(dbs.has(legacyDbName)).toBe(true)
  })

  it('round-trips non-string entry values unchanged', async () => {
    // Real-world entries are CryptoKey + Uint8Array; assert structured-clone
    // semantics by smuggling a heterogeneous value through.
    const value: KeyEntry['value'] = { kind: 'fake-CryptoKey', buf: new Uint8Array([1, 2, 3]) }
    const { backend, dbs } = makeFakeBackend({
      [legacyDbName]: { thunderbolt_ck: value },
    })

    await migrateEncryptionKeysIfNeeded(serverId, backend)

    expect(dbs.get(namespacedDbName(serverId))!.get('thunderbolt_ck')).toBe(value)
  })
})
