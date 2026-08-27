/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'bun:test'

import {
  storeKeyPair,
  getKeyPair,
  storeAK,
  getAK,
  storeDEK,
  getDEK,
  stageWrappedDEKs,
  listDEKs,
  storePrimaryKeyId,
  getPrimaryKeyId,
  storeKeyVersion,
  getKeyVersion,
  clearAllKeys,
} from './key-storage'
import { generateAK, generateDEK, generateKeyPair, generateMlKemKeyPair, wrapDEK } from './primitives'
import type { EncryptedBytes } from './primitives'

const dbName = 'thunderbolt-keys'
const storeName = 'keys'

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

/** Read a raw stored value, bypassing the key-storage API (to inspect at-rest bytes). */
const readRaw = (id: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(storeName, 'readonly')
      const get = tx.objectStore(storeName).get(id)
      get.onsuccess = () => {
        db.close()
        resolve(get.result)
      }
      get.onerror = () => {
        db.close()
        reject(get.error)
      }
    }
    open.onerror = () => reject(open.error)
  })

const listRawKeys = (): Promise<IDBValidKey[]> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(storeName, 'readonly')
      const keys = tx.objectStore(storeName).getAllKeys()
      keys.onsuccess = () => {
        db.close()
        resolve(keys.result)
      }
      keys.onerror = () => {
        db.close()
        reject(keys.error)
      }
    }
    open.onerror = () => reject(open.error)
  })

/** Seed a v1 (dbVersion 1) store with the given entries, bypassing the v2 API. */
const seedV1Store = (entries: Array<{ id: string; value: unknown }>): Promise<void> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(storeName)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(storeName, 'readwrite')
      const store = tx.objectStore(storeName)
      for (const { id, value } of entries) {
        store.put(value, id)
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  })

beforeEach(deleteDatabase)

describe('storeKeyPair / getKeyPair', () => {
  it('round-trips both key pairs, decrypting the ML-KEM secret on read', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)

    const stored = await getKeyPair()
    expect(stored?.ecdhPrivateKey.algorithm.name).toBe('ECDH')
    expect(stored?.mlkemPublicKey).toEqual(mlkem.publicKey)
    expect(stored?.mlkemSecretKey).toEqual(mlkem.secretKey)
  })

  it('returns null when no key pair is stored', async () => {
    expect(await getKeyPair()).toBeNull()
  })

  it('stores only ciphertext for the ML-KEM secret key (never plaintext at rest)', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)

    const raw = (await readRaw('thunderbolt_mlkem_secret_key')) as EncryptedBytes
    expect(raw.iv.length).toBe(12)
    expect(raw.ciphertext).not.toEqual(mlkem.secretKey)
    // AES-GCM ciphertext = plaintext + 16-byte auth tag
    expect(raw.ciphertext.length).toBe(mlkem.secretKey.length + 16)
  })
})

describe('WS1.5 — v1 plaintext ML-KEM secret read-migration', () => {
  it('reads a v1 plaintext sk and re-encrypts it in place, preserving the key', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    // v1 stored the ML-KEM secret as raw plaintext bytes.
    await seedV1Store([
      { id: 'thunderbolt_private_key', value: ecdh.privateKey },
      { id: 'thunderbolt_public_key', value: ecdh.publicKey },
      { id: 'thunderbolt_mlkem_public_key', value: mlkem.publicKey },
      { id: 'thunderbolt_mlkem_secret_key', value: mlkem.secretKey },
    ])

    // Sanity: at rest it is a plaintext Uint8Array before migration.
    expect(await readRaw('thunderbolt_mlkem_secret_key')).toBeInstanceOf(Uint8Array)

    const first = await getKeyPair()
    expect(first?.mlkemSecretKey).toEqual(mlkem.secretKey)

    // The read-migration re-encrypted it in place.
    const raw = (await readRaw('thunderbolt_mlkem_secret_key')) as EncryptedBytes
    expect(raw).not.toBeInstanceOf(Uint8Array)
    expect(raw.iv.length).toBe(12)
    expect(raw.ciphertext.length).toBe(mlkem.secretKey.length + 16)

    // Second read takes the encrypted path and still yields the same key.
    const second = await getKeyPair()
    expect(second?.mlkemSecretKey).toEqual(mlkem.secretKey)
  })
})

describe('non-destructive v1→v2 upgrade', () => {
  it('preserves existing v1 entries on the dbVersion bump (NEVER wipes)', async () => {
    await seedV1Store([{ id: 'thunderbolt_ck', value: 'v1-leftover' }])

    // Any v2 API call opens the db at version 2, triggering the upgrade.
    expect(await getAK()).toBeNull()

    // The v1 entry survives — the upgrade is non-destructive.
    expect(await readRaw('thunderbolt_ck')).toBe('v1-leftover')
    expect(await listRawKeys()).toContain('thunderbolt_ck')
  })
})

describe('storeAK / getAK', () => {
  it('round-trips the AK as a non-extractable AES-KW CryptoKey usable as the keyring gate', async () => {
    const ak = await generateAK()
    await storeAK(ak)

    const stored = await getAK()
    expect(stored?.algorithm.name).toBe('AES-KW')
    expect(stored?.extractable).toBe(false)
    expect(typeof (await wrapDEK(await generateDEK(true), stored as CryptoKey))).toBe('string')
  })

  it('returns null when no AK is stored', async () => {
    expect(await getAK()).toBeNull()
  })
})

describe('DEK keyring entries', () => {
  it('stores DEKs as wrapped base64 strings, not CryptoKeys', async () => {
    const wrapped = await wrapDEK(await generateDEK(true), await generateAK())
    await storeDEK('0', wrapped)
    expect(await getDEK('0')).toBe(wrapped)
    expect(typeof (await readRaw('thunderbolt_dek_0'))).toBe('string')
  })

  it('returns null for an unknown key_id', async () => {
    expect(await getDEK('99')).toBeNull()
  })

  it('stageWrappedDEKs stores the full keyring and listDEKs enumerates it (incl. the "v1" slot)', async () => {
    await stageWrappedDEKs([
      { keyId: '0', wrappedKey: 'blob-0' },
      { keyId: '1', wrappedKey: 'blob-1' },
      { keyId: 'v1', wrappedKey: 'blob-v1' },
    ])

    const entries = await listDEKs()
    expect(entries.sort((a, b) => a.keyId.localeCompare(b.keyId))).toEqual([
      { keyId: '0', wrappedKey: 'blob-0' },
      { keyId: '1', wrappedKey: 'blob-1' },
      { keyId: 'v1', wrappedKey: 'blob-v1' },
    ])
  })

  it('listDEKs ignores non-DEK entries', async () => {
    await storeAK(await generateAK())
    await storeDEK('0', 'blob-0')
    expect(await listDEKs()).toEqual([{ keyId: '0', wrappedKey: 'blob-0' }])
  })

  it('stageWrappedDEKs overwrites existing entries (AK-rotation re-wrap)', async () => {
    await storeDEK('0', 'old-blob')
    await stageWrappedDEKs([{ keyId: '0', wrappedKey: 'new-blob' }])
    expect(await getDEK('0')).toBe('new-blob')
  })
})

describe('primary key_id + key_version pointers', () => {
  it('round-trips the primary key_id', async () => {
    expect(await getPrimaryKeyId()).toBeNull()
    await storePrimaryKeyId('0')
    expect(await getPrimaryKeyId()).toBe('0')
  })

  it('round-trips the last applied key_version as a number', async () => {
    expect(await getKeyVersion()).toBeNull()
    await storeKeyVersion(3)
    expect(await getKeyVersion()).toBe(3)
    await storeKeyVersion(4)
    expect(await getKeyVersion()).toBe(4)
  })
})

describe('clearAllKeys', () => {
  it('wipes the AK, key pair, and every dynamically-named DEK entry', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)
    await storeAK(await generateAK())
    await storeKeyVersion(2)
    await stageWrappedDEKs([
      { keyId: '0', wrappedKey: 'blob-0' },
      { keyId: '7', wrappedKey: 'blob-7' },
      { keyId: 'v1', wrappedKey: 'blob-v1' },
    ])

    await clearAllKeys()

    expect(await listRawKeys()).toEqual([])
    expect(await getKeyPair()).toBeNull()
    expect(await getAK()).toBeNull()
    expect(await listDEKs()).toEqual([])
    expect(await getKeyVersion()).toBeNull()
  })
})
