/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'bun:test'

import { encrypt, generateAK, mintDEK } from '@/crypto/primitives'
import { clearAllKeys, storeAK, storePrimaryKeyId, storeWrappedDEK } from '@/crypto/key-storage'
import { encodeAAD, encV2Prefix, type KeyId } from '@shared/e2ee-types'
import { formatWireValue, isV2EncryptedValue, parseWireValue } from './wire-format'
import { codec, invalidateKeyCache, resetCodecState, setKeysSyncChannelForTesting, type KeysSyncMessage } from './codec'

const ctx = { table: 'tasks', column: 'item', rowId: 'row-1' }

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
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
    const minted = await mintDEK(ak)
    await storeWrappedDEK(keyId, minted.wrappedKey)
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
  fakeChannel = installFakeChannel()
  resetCodecState()
  fakeChannel.posted.length = 0
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

  it('genuinely re-encrypts values already carrying the __enc: prefix (THU-429)', async () => {
    await setupKeyring(['0'], '0')
    for (const inner of ['__enc:aXY=:Y3Q=', `${encV2Prefix}0:aXY=:Y3Q=`]) {
      const encoded = await codec.encode(inner, ctx)
      expect(encoded).not.toBe(inner)
      expect(isV2EncryptedValue(encoded)).toBe(true)
      expect(await codec.decode(encoded, ctx)).toBe(inner)
    }
  })

  it('selects the primary key_id and still decodes values written under an old key_id', async () => {
    const { ak } = await setupKeyring(['0'], '0')
    const oldValue = await codec.encode('written under 0', ctx)
    expect(parseWireValue(oldValue)?.keyId).toBe('0')

    const minted = await mintDEK(ak)
    await storeWrappedDEK('1', minted.wrappedKey)
    await storePrimaryKeyId('1')
    invalidateKeyCache()

    const newValue = await codec.encode('written under 1', ctx)
    expect(parseWireValue(newValue)?.keyId).toBe('1')
    expect(await codec.decode(oldValue, ctx)).toBe('written under 0')
    expect(await codec.decode(newValue, ctx)).toBe('written under 1')
  })

  it("falls back to key_id '0' when no primary pointer is set but DEK 0 exists", async () => {
    const ak = await generateAK()
    await storeAK(ak)
    const minted = await mintDEK(ak)
    await storeWrappedDEK('0', minted.wrappedKey)

    const encoded = await codec.encode('fallback', ctx)
    expect(parseWireValue(encoded)?.keyId).toBe('0')
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
    invalidateKeyCache()
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

describe('decode', () => {
  it('passes plaintext and malformed __enc: values through', async () => {
    await setupKeyring(['0'], '0')
    expect(await codec.decode('just plain text', ctx)).toBe('just plain text')
    expect(await codec.decode('__enc:no-separator-here', ctx)).toBe('__enc:no-separator-here')
  })

  it('returns v1 two-segment values as-is without attempting decryption', async () => {
    await setupKeyring(['0'], '0')
    const v1Value = '__enc:MTIzNDU2Nzg5MGFi:c29tZS1jaXBoZXJ0ZXh0'
    expect(await codec.decode(v1Value, ctx)).toBe(v1Value)
  })

  it('returns the raw v2 value when ctx is missing (cannot rebuild AAD)', async () => {
    await setupKeyring(['0'], '0')
    const encoded = await codec.encode('secret', ctx)
    expect(await codec.decode(encoded)).toBe(encoded)
  })

  it('returns the raw value when no keys exist (pre-unlock fail-open)', async () => {
    const wireValue = formatWireValue('0', 'aXY=', 'Y3Q=')
    expect(await codec.decode(wireValue, ctx)).toBe(wireValue)
    expect(fakeChannel.posted).toEqual([])
  })

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
    const minted = await mintDEK(ak)
    // The SAME DEK staged under both ids isolates the key_id AAD dimension
    // from a plain key mismatch.
    await storeWrappedDEK('0', minted.wrappedKey)
    await storeWrappedDEK('1', minted.wrappedKey)
    await storePrimaryKeyId('0')

    const encoded = await codec.encode('secret', ctx)
    const parsed = parseWireValue(encoded)
    expect(parsed).not.toBeNull()
    const tampered = formatWireValue('1', parsed!.iv, parsed!.ciphertext)
    expect(await codec.decode(tampered, ctx)).toBe(tampered)
  })
})

describe('keys-sync channel protocol', () => {
  it('invalidateKeyCache broadcasts invalidate; resetCodecState broadcasts reset', () => {
    invalidateKeyCache()
    resetCodecState()
    expect(fakeChannel.posted).toEqual([{ type: 'invalidate' }, { type: 'reset' }])
  })

  it("an 'invalidate' message forces a re-read of the primary key_id from IndexedDB", async () => {
    const { ak } = await setupKeyring(['0'], '0')
    await codec.encode('caches primary 0', ctx)

    const minted = await mintDEK(ak)
    await storeWrappedDEK('1', minted.wrappedKey)
    await storePrimaryKeyId('1')
    fakeChannel.deliver({ type: 'invalidate' })

    const encoded = await codec.encode('now under 1', ctx)
    expect(parseWireValue(encoded)?.keyId).toBe('1')
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
    const minted = await mintDEK(ak)
    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, '1')
    const { iv, ciphertext } = await encrypt('future value', minted.dek, aad)
    const wireValue = formatWireValue('1', iv, ciphertext)

    const decodePromise = codec.decode(wireValue, ctx)
    await waitFor(() => fakeChannel.posted.some((message) => message.type === 'key-request'))
    expect(fakeChannel.posted).toContainEqual({ type: 'key-request', keyId: '1', reason: 'unknown-key' })

    await storeWrappedDEK('1', minted.wrappedKey)
    fakeChannel.deliver({ type: 'key-staged', keyId: '1' })

    expect(await decodePromise).toBe('future value')
  })

  it("unwrap failure: posts key-request (unwrap-failed) and re-reads the AK after 'ak-refreshed'", async () => {
    // Post-revocation shape: this device still holds the OLD AK while key "1"
    // arrives wrapped under the NEW AK.
    await setupKeyring(['0'], '0')
    const newAK = await generateAK()
    const minted = await mintDEK(newAK)
    await storeWrappedDEK('1', minted.wrappedKey)

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
    const minted = await mintDEK(otherAK)
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
    const minted = await mintDEK(ak)
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

    await storeWrappedDEK('1', minted.wrappedKey)
    fakeChannel.deliver({ type: 'key-staged', keyId: '1' })

    expect(await decodeA).toBe('value A')
    expect(await decodeB).toBe('value B')
  })
})
