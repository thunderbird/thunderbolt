/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'

import {
  clearAllKeys,
  encrypt,
  generateAK,
  generateDEK,
  getPrimaryKeyId,
  mintDEK,
  storeAK,
  storeDEK,
  storePrimaryKeyId,
  wrapDEK,
} from '@/crypto'
import { encodeAAD, encPrefix, encV2Prefix, legacyKeyId, type KeyId } from '@shared/e2ee-types'
import { formatWireValue, isV2EncryptedValue, parseWireValue } from './wire-format'
import {
  codec,
  invalidateAdoptedKeyring,
  invalidateKeyringCache,
  resetCodecState,
  setKeysSyncChannelForTesting,
  type KeysSyncMessage,
} from './codec'

const ctx = { table: 'tasks', column: 'item', rowId: 'row-1' }

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

/**
 * Write the primary-pointer entry straight into IndexedDB, around
 * `storePrimaryKeyId`. Models the only way a non-mintable pointer can exist
 * post-THU-876: local state written by something that is not this API.
 */
const plantRawPrimaryKeyId = (keyId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open('thunderbolt-keys')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('keys', 'readwrite')
      tx.objectStore('keys').put(keyId, 'thunderbolt_primary_key_id')
      tx.oncomplete = () => {
        open.result.close()
        resolve()
      }
      tx.onerror = () => {
        open.result.close()
        reject(tx.error)
      }
    }
  })

type FakeChannel = {
  posted: KeysSyncMessage[]
  deliver: (message: KeysSyncMessage) => void
}

const installFakeChannel = (): FakeChannel => {
  const posted: KeysSyncMessage[] = []
  const listeners: Array<(message: KeysSyncMessage) => void> = []
  setKeysSyncChannelForTesting({
    postMessage: (message) => posted.push(message),
    onMessage: (listener) => listeners.push(listener),
  })
  return { posted, deliver: (message) => listeners.forEach((listener) => listener(message)) }
}

const setupKeyring = async (keyIds: KeyId[], primary: KeyId) => {
  const ak = await generateAK()
  await storeAK(ak)
  const deks = new Map<KeyId, { dek: CryptoKey; wrappedKey: string }>()
  for (const keyId of keyIds) {
    const minted = await mintDEK(ak, keyId)
    await storeDEK(keyId, minted.wrappedKey)
    deks.set(keyId, minted)
  }
  await storePrimaryKeyId(primary)
  return { ak, deks }
}

// setImmediate is NOT faked by the global sinon fake-timers preload (setTimeout
// and Date are), so poll on it to let fake-indexeddb callbacks progress.
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) {
      return
    }
    await flushAsync()
  }
  throw new Error('waitFor timed out')
}

let fakeChannel: FakeChannel

beforeEach(async () => {
  await deleteDatabase()
  // Reset through the key-storage module too: `src/services/encryption.test.ts`
  // mock.module's `@/crypto/key-storage` with a Map-backed impl that bun leaks
  // across files, and `deleteDatabase()` (fake-indexeddb) does not clear those
  // Maps — `clearAllKeys()` empties whichever backend is bound.
  await clearAllKeys()
  fakeChannel = installFakeChannel()
  resetCodecState()
  fakeChannel.posted.length = 0
})

// The beforeEach cleans on ENTRY, so the file's last test would otherwise leave
// its staged keyring behind — and bun shares one process across test files, so a
// later file consulting the real gate (hasStagedAK) would read as armed.
afterAll(async () => {
  await deleteDatabase()
  await clearAllKeys()
  resetCodecState()
})

describe('encode', () => {
  it('round-trips a value under the primary DEK in v2 wire format', async () => {
    await setupKeyring(['0'], '0')
    const encoded = await codec.encode('hello world', ctx)
    expect(encoded.startsWith(`${encV2Prefix}0:`)).toBe(true)
    expect(await codec.decode(encoded, ctx)).toBe('hello world')
  })

  it('round-trips unicode content and the empty string', async () => {
    await setupKeyring(['0'], '0')
    for (const original of ['Hello 🌍 café résumé', '']) {
      const encoded = await codec.encode(original, ctx)
      expect(isV2EncryptedValue(encoded)).toBe(true)
      expect(await codec.decode(encoded, ctx)).toBe(original)
    }
  })

  it('genuinely re-encrypts values already carrying the __enc: prefix (THU-429, no idempotency bypass)', async () => {
    await setupKeyring(['0'], '0')
    for (const inner of ['__enc:aXY=:Y3Q=', `${encV2Prefix}0:aXY=:Y3Q=`]) {
      const encoded = await codec.encode(inner, ctx)
      expect(encoded).not.toBe(inner)
      expect(isV2EncryptedValue(encoded)).toBe(true)
      expect(await codec.decode(encoded, ctx)).toBe(inner)
    }
  })

  it('never encodes under the reserved read-only "v1" slot', async () => {
    // Only the "v1" slot is staged as a DEK, with no primary pointer — encode
    // must NOT fall back to it (it is decrypt-only). An AK is present, so the
    // account is set up: encode fails CLOSED (refuses plaintext) rather than
    // encrypting under "v1" or leaking cleartext.
    const ak = await generateAK()
    await storeAK(ak)
    const minted = await mintDEK(ak, legacyKeyId)
    await storeDEK(legacyKeyId, minted.wrappedKey)
    await expect(codec.encode('x', ctx)).rejects.toThrow('refusing to upload plaintext')
  })

  it('refuses to encode when a TAMPERED primary pointer names the "v1" slot (THU-876)', async () => {
    // `storePrimaryKeyId` refuses this value now, so the only way to reach this
    // state is a write that went AROUND that API: an in-origin script (A6), or
    // a device poisoned before THU-876 shipped. Enforcing the grammar here, at
    // the point of use, is what makes such a compromise non-persistent — the
    // pointer is durable, so without this guard one transient write steers
    // every future write onto the decrypt-only legacy CK.
    const ak = await generateAK()
    await storeAK(ak)
    await storeDEK('0', (await mintDEK(ak, '0')).wrappedKey)
    await storeDEK(legacyKeyId, (await mintDEK(ak, legacyKeyId)).wrappedKey)
    await plantRawPrimaryKeyId(legacyKeyId)
    resetCodecState()

    // Precondition: the plant is visible to the codec. Both DEKs are staged, so
    // WITHOUT the guard this encode succeeds and emits `__enc:v2:v1:…`.
    expect(await getPrimaryKeyId()).toBe(legacyKeyId)
    await expect(codec.encode('x', ctx)).rejects.toThrow('non-mintable primary key_id')
  })

  it('fails closed when no primary pointer is set, even if DEK 0 exists (THU-890)', async () => {
    // The DEK-0 write fallback was REMOVED: the pointer's only trusted source
    // is an adopted AK envelope, so "no pointer" means "no verified envelope
    // yet" — silently sealing under "0" was a downgrade primitive. An AK is
    // present, so encode must fail closed rather than pass plaintext through.
    const ak = await generateAK()
    await storeAK(ak)
    const minted = await mintDEK(ak, '0')
    await storeDEK('0', minted.wrappedKey)

    await expect(codec.encode('fallback', ctx)).rejects.toThrow('Encryption keys unavailable after E2EE setup')
  })

  it('throws when called without an EncryptionContext', async () => {
    await setupKeyring(['0'], '0')
    expect(codec.encode('x')).rejects.toThrow('EncryptionContext')
  })

  it('fails open before setup: passes plaintext through when no keys exist', async () => {
    expect(await codec.encode('hello', ctx)).toBe('hello')
  })

  it('fails closed after setup: throws when keys vanish mid-session', async () => {
    await setupKeyring(['0'], '0')
    await codec.encode('first', ctx)

    await clearAllKeys()
    invalidateKeyringCache()
    expect(codec.encode('second', ctx)).rejects.toThrow('refusing to upload plaintext')
  })

  it('resetCodecState clears the setup flag so encode fails open again', async () => {
    await setupKeyring(['0'], '0')
    await codec.encode('first', ctx)

    await clearAllKeys()
    resetCodecState()
    expect(await codec.encode('second', ctx)).toBe('second')
  })
})

describe('decode — dual-read matrix', () => {
  it('passes plaintext and malformed __enc: values through', async () => {
    await setupKeyring(['0'], '0')
    expect(await codec.decode('just plain text', ctx)).toBe('just plain text')
    expect(await codec.decode('__enc:no-separator-here', ctx)).toBe('__enc:no-separator-here')
  })

  it('decodes a legacy v1 value via the "v1" slot with NO AAD', async () => {
    const { ak } = await setupKeyring(['0'], '0')
    // The "v1" slot is an ordinary AES-GCM DEK; a v1 value was written with it
    // and no AAD.
    const legacy = await mintDEK(ak, legacyKeyId)
    await storeDEK(legacyKeyId, legacy.wrappedKey)
    const { iv, ciphertext } = await encrypt('legacy secret', legacy.dek)
    const v1Value = `${encPrefix}${iv}:${ciphertext}`

    expect(await codec.decode(v1Value, ctx)).toBe('legacy secret')
    // v1 carries no AAD, so ctx is irrelevant — decodes regardless of table/column/row.
    expect(await codec.decode(v1Value, { table: 'other', column: 'x', rowId: 'zzz' })).toBe('legacy secret')
  })

  it('decodes a v2 value bound to the correct AAD', async () => {
    await setupKeyring(['0'], '0')
    const encoded = await codec.encode('secret', ctx)
    expect(parseWireValue(encoded)?.keyId).toBe('0')
    expect(await codec.decode(encoded, ctx)).toBe('secret')
  })

  it('returns the raw v2 value when ctx is missing (cannot rebuild AAD)', async () => {
    await setupKeyring(['0'], '0')
    const encoded = await codec.encode('secret', ctx)
    expect(await codec.decode(encoded)).toBe(encoded)
  })

  it('returns the raw value when no keys exist (pre-unlock fail-open, no key-request)', async () => {
    const wireValue = formatWireValue('0', 'aXY=', 'Y3Q=')
    expect(await codec.decode(wireValue, ctx)).toBe(wireValue)
    expect(fakeChannel.posted).toEqual([])
  })
})

describe('decode — AAD tamper negatives', () => {
  it('fails GCM and returns the raw value when ciphertext moves across table/column/rowId', async () => {
    await setupKeyring(['0'], '0')
    const encoded = await codec.encode('secret', ctx)
    expect(await codec.decode(encoded, { ...ctx, table: 'settings' })).toBe(encoded)
    expect(await codec.decode(encoded, { ...ctx, column: 'other' })).toBe(encoded)
    expect(await codec.decode(encoded, { ...ctx, rowId: 'row-2' })).toBe(encoded)
    expect(await codec.decode(encoded, ctx)).toBe('secret')
  })

  it('fails GCM when the wire key_id is swapped (key_id AAD dimension)', async () => {
    const ak = await generateAK()
    await storeAK(ak)
    // The SAME DEK material staged under both ids isolates the wire key_id's
    // data-AAD dimension from a plain key mismatch. Each id gets its own wrap
    // (the wrap itself binds key_id since THU-893, so one blob cannot serve two
    // ids) — the MATERIAL being shared is what keeps this a data-AAD test.
    const dek = await generateDEK(true)
    await storeDEK('0', await wrapDEK(dek, ak, '0'))
    await storeDEK('1', await wrapDEK(dek, ak, '1'))
    await storePrimaryKeyId('0')

    const encoded = await codec.encode('secret', ctx)
    const parsed = parseWireValue(encoded)
    expect(parsed).not.toBeNull()
    const tampered = formatWireValue('1', parsed!.iv, parsed!.ciphertext)
    expect(await codec.decode(tampered, ctx)).toBe(tampered)
  })
})

describe('keys-sync channel protocol', () => {
  it('invalidateKeyringCache broadcasts invalidate; resetCodecState broadcasts reset', () => {
    invalidateKeyringCache()
    resetCodecState()
    expect(fakeChannel.posted).toEqual([{ type: 'invalidate' }, { type: 'reset' }])
  })

  it('invalidateKeyringCache keeps the primary pointer; resetCodecState re-reads it', async () => {
    await setupKeyring(['0', '1'], '0')
    expect(parseWireValue(await codec.encode('a', ctx))?.keyId).toBe('0')

    await storePrimaryKeyId('1')
    invalidateKeyringCache()
    // Primary pointer kept → still encodes under 0.
    expect(parseWireValue(await codec.encode('b', ctx))?.keyId).toBe('0')

    resetCodecState()
    // Full reset drops the primary pointer → re-reads 1 from IndexedDB.
    expect(parseWireValue(await codec.encode('c', ctx))?.keyId).toBe('1')
  })

  it('invalidateAdoptedKeyring drops the primary pointer and broadcasts primary-adopted', async () => {
    await setupKeyring(['0', '1'], '0')
    // Warm the encoder — this is the state a surviving device is in when a
    // sibling's revocation rotates the primary.
    expect(parseWireValue(await codec.encode('a', ctx))?.keyId).toBe('0')

    await storePrimaryKeyId('1')
    invalidateAdoptedKeyring()
    // Pointer dropped → re-reads 1 from IndexedDB (contrast `invalidateKeyringCache`,
    // which keeps the warm pointer and would still encode under 0 here).
    expect(parseWireValue(await codec.encode('b', ctx))?.keyId).toBe('1')
    expect(fakeChannel.posted).toContainEqual({ type: 'primary-adopted' })
  })

  it("a 'primary-adopted' message re-reads the pointer without clearing the setup flag", async () => {
    await setupKeyring(['0', '1'], '0')
    expect(parseWireValue(await codec.encode('a', ctx))?.keyId).toBe('0')

    // Another context (the main thread that ran `applyKeyring`) persisted the
    // adopted pointer and broadcast the invalidation.
    await storePrimaryKeyId('1')
    fakeChannel.deliver({ type: 'primary-adopted' })
    expect(parseWireValue(await codec.encode('b', ctx))?.keyId).toBe('1')

    // Unlike 'reset', adoption must not disturb the fail-closed setup latch:
    // with the keys gone, encode still throws rather than passing plaintext.
    await clearAllKeys()
    fakeChannel.deliver({ type: 'primary-adopted' })
    await expect(codec.encode('c', ctx)).rejects.toThrow('refusing to upload plaintext')
  })

  it("a 'reset' message clears the setup flag so encode fails open", async () => {
    await setupKeyring(['0'], '0')
    await codec.encode('first', ctx)

    await clearAllKeys()
    fakeChannel.deliver({ type: 'reset' })
    expect(await codec.encode('second', ctx)).toBe('second')
  })

  it("unknown key_id: posts key-request (unknown-key) and resolves after 'key-staged'", async () => {
    const { ak } = await setupKeyring(['0'], '0')
    const minted = await mintDEK(ak, '1')
    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, '1')
    const { iv, ciphertext } = await encrypt('future value', minted.dek, aad)
    const wireValue = formatWireValue('1', iv, ciphertext)

    const decodePromise = codec.decode(wireValue, ctx)
    await waitFor(() => fakeChannel.posted.some((message) => message.type === 'key-request'))
    expect(fakeChannel.posted).toContainEqual({ type: 'key-request', keyId: '1', reason: 'unknown-key' })

    await storeDEK('1', minted.wrappedKey)
    fakeChannel.deliver({ type: 'key-staged', keyId: '1' })

    expect(await decodePromise).toBe('future value')
  })

  it("a not-yet-staged v1 slot triggers a key-request for 'v1' and self-heals", async () => {
    const { ak } = await setupKeyring(['0'], '0')
    // Produce a legacy v1 value, but do NOT stage the "v1" slot yet.
    const legacy = await mintDEK(ak, legacyKeyId)
    const { iv, ciphertext } = await encrypt('legacy secret', legacy.dek)
    const v1Value = `${encPrefix}${iv}:${ciphertext}`

    const decodePromise = codec.decode(v1Value, ctx)
    await waitFor(() => fakeChannel.posted.some((message) => message.type === 'key-request'))
    expect(fakeChannel.posted).toContainEqual({ type: 'key-request', keyId: legacyKeyId, reason: 'unknown-key' })

    await storeDEK(legacyKeyId, legacy.wrappedKey)
    fakeChannel.deliver({ type: 'key-staged', keyId: legacyKeyId })

    expect(await decodePromise).toBe('legacy secret')
  })

  it('a server-invented key_id costs nothing — no key-request, no stall, value left opaque', async () => {
    await setupKeyring(['0'], '0')
    // A2 stamping rows with endlessly distinct junk labels used to buy a
    // key-request round trip and a ~10s decode stall per distinct id.
    const planted = '__enc:v2:9999999999999999:aXY=:Y3Q='

    expect(await codec.decode(planted, ctx)).toBe(planted)
    expect(fakeChannel.posted.filter((message) => message.type === 'key-request')).toEqual([])
  })

  it("unwrap failure: posts key-request (unwrap-failed) and re-reads the AK after 'ak-refreshed'", async () => {
    // Post-revocation shape: this device still holds the OLD AK while key "1"
    // arrives wrapped under the NEW AK.
    await setupKeyring(['0'], '0')
    const newAK = await generateAK()
    const minted = await mintDEK(newAK, '1')
    await storeDEK('1', minted.wrappedKey)

    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, '1')
    const { iv, ciphertext } = await encrypt('post-revocation', minted.dek, aad)
    const wireValue = formatWireValue('1', iv, ciphertext)

    const decodePromise = codec.decode(wireValue, ctx)
    await waitFor(() => fakeChannel.posted.some((message) => message.type === 'key-request'))
    expect(fakeChannel.posted).toContainEqual({ type: 'key-request', keyId: '1', reason: 'unwrap-failed' })

    // Main thread (D2) refreshes the AK envelope, stores the new AK, then signals.
    await storeAK(newAK)
    fakeChannel.deliver({ type: 'ak-refreshed' })

    expect(await decodePromise).toBe('post-revocation')
  })

  it('still fails open (raw value) when the staged key never arrives and the retry fails', async () => {
    await setupKeyring(['0'], '0')
    const otherAK = await generateAK()
    const minted = await mintDEK(otherAK, '9')
    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, '9')
    const { iv, ciphertext } = await encrypt('unreachable', minted.dek, aad)
    const wireValue = formatWireValue('9', iv, ciphertext)

    const decodePromise = codec.decode(wireValue, ctx)
    await waitFor(() => fakeChannel.posted.some((message) => message.type === 'key-request'))
    // Signal without staging anything — the retry still finds no wrapped key.
    fakeChannel.deliver({ type: 'key-staged', keyId: '9' })

    expect(await decodePromise).toBe(wireValue)
  })

  it('coalesces concurrent decodes of the same unknown key_id into a single key-request', async () => {
    const { ak } = await setupKeyring(['0'], '0')
    const minted = await mintDEK(ak, '1')
    const encryptUnder1 = async (plaintext: string, rowId: string) => {
      const aad = encodeAAD(ctx.table, ctx.column, rowId, '1')
      const { iv, ciphertext } = await encrypt(plaintext, minted.dek, aad)
      return formatWireValue('1', iv, ciphertext)
    }
    const wireA = await encryptUnder1('value A', 'row-a')
    const wireB = await encryptUnder1('value B', 'row-b')

    const decodeA = codec.decode(wireA, { ...ctx, rowId: 'row-a' })
    const decodeB = codec.decode(wireB, { ...ctx, rowId: 'row-b' })
    await waitFor(() => fakeChannel.posted.some((message) => message.type === 'key-request'))
    // Let the second decode reach the (coalesced) pending request.
    for (let i = 0; i < 20; i++) {
      await flushAsync()
    }
    expect(fakeChannel.posted.filter((message) => message.type === 'key-request')).toHaveLength(1)

    await storeDEK('1', minted.wrappedKey)
    fakeChannel.deliver({ type: 'key-staged', keyId: '1' })

    expect(await decodeA).toBe('value A')
    expect(await decodeB).toBe('value B')
  })
})
