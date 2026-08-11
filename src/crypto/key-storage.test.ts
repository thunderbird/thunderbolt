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
  storeWrappedDEK,
  getWrappedDEK,
  stageWrappedDEKs,
  listWrappedDEKs,
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

beforeEach(deleteDatabase)

describe('storeKeyPair / getKeyPair', () => {
  it('round-trips both key pairs, decrypting the ML-KEM secret on read', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)

    const stored = await getKeyPair()
    expect(stored).not.toBeNull()
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
    expect(raw.iv).toBeInstanceOf(Uint8Array)
    expect(raw.iv.length).toBe(12)
    expect(raw.ciphertext).toBeInstanceOf(Uint8Array)
    expect(raw.ciphertext).not.toEqual(mlkem.secretKey)
    // AES-GCM ciphertext = plaintext + 16-byte auth tag
    expect(raw.ciphertext.length).toBe(mlkem.secretKey.length + 16)
  })
})

describe('storeAK / getAK', () => {
  it('round-trips the AK as a non-extractable AES-KW CryptoKey', async () => {
    const ak = await generateAK()
    await storeAK(ak)

    const stored = await getAK()
    expect(stored).not.toBeNull()
    expect(stored?.algorithm.name).toBe('AES-KW')
    expect(stored?.extractable).toBe(false)

    // The retrieved AK must be usable as the keyring gate.
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, stored as CryptoKey)
    expect(typeof wrapped).toBe('string')
  })

  it('returns null when no AK is stored', async () => {
    expect(await getAK()).toBeNull()
  })
})

describe('wrapped DEK entries', () => {
  it('stores wrapped DEKs as base64 strings, not CryptoKeys', async () => {
    const ak = await generateAK()
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, ak)

    await storeWrappedDEK('0', wrapped)
    expect(await getWrappedDEK('0')).toBe(wrapped)
    expect(typeof (await readRaw('thunderbolt_dek_0'))).toBe('string')
  })

  it('returns null for an unknown key_id', async () => {
    expect(await getWrappedDEK('99')).toBeNull()
  })

  it('stageWrappedDEKs stores the full keyring and listWrappedDEKs enumerates it', async () => {
    await stageWrappedDEKs([
      { keyId: '0', wrappedKey: 'blob-0' },
      { keyId: '1', wrappedKey: 'blob-1' },
      { keyId: 'ws1', wrappedKey: 'blob-ws1' },
    ])

    const entries = await listWrappedDEKs()
    expect(entries.sort((a, b) => a.keyId.localeCompare(b.keyId))).toEqual([
      { keyId: '0', wrappedKey: 'blob-0' },
      { keyId: '1', wrappedKey: 'blob-1' },
      { keyId: 'ws1', wrappedKey: 'blob-ws1' },
    ])
  })

  it('listWrappedDEKs ignores non-DEK entries', async () => {
    const ak = await generateAK()
    await storeAK(ak)
    await storeWrappedDEK('0', 'blob-0')

    const entries = await listWrappedDEKs()
    expect(entries).toEqual([{ keyId: '0', wrappedKey: 'blob-0' }])
  })

  it('stageWrappedDEKs overwrites existing entries (AK-rotation re-wrap)', async () => {
    await storeWrappedDEK('0', 'old-blob')
    await stageWrappedDEKs([{ keyId: '0', wrappedKey: 'new-blob' }])
    expect(await getWrappedDEK('0')).toBe('new-blob')
  })
})

describe('storeKeyVersion / getKeyVersion', () => {
  it('returns null when no key_version was ever recorded', async () => {
    expect(await getKeyVersion()).toBeNull()
  })

  it('round-trips the last applied key_version as a number', async () => {
    await storeKeyVersion(3)
    expect(await getKeyVersion()).toBe(3)
    await storeKeyVersion(4)
    expect(await getKeyVersion()).toBe(4)
  })

  it('is wiped by clearAllKeys (baseline resets on full wipe)', async () => {
    await storeKeyVersion(2)
    await clearAllKeys()
    expect(await getKeyVersion()).toBeNull()
  })
})

describe('clearAllKeys', () => {
  it('wipes the AK, key pair, and every dynamically-named DEK entry', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)
    await storeAK(await generateAK())
    await stageWrappedDEKs([
      { keyId: '0', wrappedKey: 'blob-0' },
      { keyId: '1', wrappedKey: 'blob-1' },
      { keyId: '7', wrappedKey: 'blob-7' },
      { keyId: 'ws1', wrappedKey: 'blob-ws1' },
    ])

    await clearAllKeys()

    expect(await listRawKeys()).toEqual([])
    expect(await getKeyPair()).toBeNull()
    expect(await getAK()).toBeNull()
    expect(await listWrappedDEKs()).toEqual([])
  })
})

describe('dbVersion 2 upgrade', () => {
  it('wipes a v1 store on upgrade (beta reset — v1 keys abandoned)', async () => {
    // Simulate a v1 database with a leftover value.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(dbName, 1)
      open.onupgradeneeded = () => open.result.createObjectStore(storeName)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).put('v1-leftover', 'thunderbolt_ck')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      open.onerror = () => reject(open.error)
    })

    // Any v2 API call triggers the upgrade, which drops the store.
    expect(await getAK()).toBeNull()
    expect(await listRawKeys()).toEqual([])
  })
})
