/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { orgEnvelopeVersion, orgEscrowHkdfInfo, p256RawPublicKeyLength } from '@shared/e2ee-types'
import {
  importOrgPublicKey,
  wrapAKForOrg,
  generateKeyPair,
  generateMlKemKeyPair,
  generateAK,
  generateDEK,
  mintDEK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  deriveMlKemAtRestKey,
  wrapAK,
  rewrapAK,
  unwrapAK,
  wrapDEK,
  unwrapDEK,
  rewrapKeyring,
  unwrapLegacyCK,
  wrapLegacyCK,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  base64ToUint8Array,
  uint8ArrayToBase64,
} from './primitives'

describe('generateKeyPair', () => {
  it('generates an ECDH P-256 key pair', async () => {
    const keyPair = await generateKeyPair()
    expect(keyPair.publicKey.algorithm.name).toBe('ECDH')
    expect(keyPair.privateKey.extractable).toBe(false)
  })
})

describe('generateMlKemKeyPair', () => {
  it('generates an ML-KEM-768 key pair with correct sizes', () => {
    const keyPair = generateMlKemKeyPair()
    expect(keyPair.publicKey.length).toBe(1184)
    expect(keyPair.secretKey.length).toBe(2400)
  })

  it('generates different key pairs each time', () => {
    const kp1 = generateMlKemKeyPair()
    const kp2 = generateMlKemKeyPair()
    expect(kp1.secretKey).not.toEqual(kp2.secretKey)
  })
})

describe('exportMlKemPublicKey / importMlKemPublicKey', () => {
  it('round-trips an ML-KEM public key through base64', () => {
    const keyPair = generateMlKemKeyPair()
    const imported = importMlKemPublicKey(exportMlKemPublicKey(keyPair.publicKey))
    expect(imported).toEqual(keyPair.publicKey)
  })
})

describe('generateAK', () => {
  it('generates a non-extractable AES-GCM key with wrap/unwrap usages only', async () => {
    const ak = await generateAK()
    expect(ak.algorithm.name).toBe('AES-GCM')
    expect(ak.extractable).toBe(false)
    expect([...ak.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('cannot encrypt data (usage separation is the point)', async () => {
    const ak = await generateAK()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    await expect(crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ak, new TextEncoder().encode('nope'))).rejects.toThrow()
  })
})

describe('generateDEK', () => {
  it('generates a non-extractable AES-GCM key with encrypt/decrypt usages only', async () => {
    const dek = await generateDEK()
    expect(dek.algorithm.name).toBe('AES-GCM')
    expect(dek.extractable).toBe(false)
    expect([...dek.usages].sort()).toEqual(['decrypt', 'encrypt'])
  })

  it('cannot wrap keys', async () => {
    const dek = await generateDEK()
    const other = await generateDEK(true)
    await expect(crypto.subtle.wrapKey('raw', other, dek, 'AES-KW')).rejects.toThrow()
  })
})

describe('reimportAsNonExtractable', () => {
  it('converts an extractable AK to a non-extractable AES-GCM key', async () => {
    const nonExtractable = await reimportAsNonExtractable(await generateAK(true))
    expect(nonExtractable.extractable).toBe(false)
    expect(nonExtractable.algorithm.name).toBe('AES-GCM')
    expect([...nonExtractable.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('reimported AK unwraps a DEK wrapped by the original', async () => {
    const extractableAK = await generateAK(true)
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, extractableAK, '0')
    const unwrapped = await unwrapDEK(wrapped, await reimportAsNonExtractable(extractableAK), '0')
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
  })
})

describe('exportPublicKey / importPublicKey', () => {
  it('round-trips a public key through base64', async () => {
    const keyPair = await generateKeyPair()
    const imported = await importPublicKey(await exportPublicKey(keyPair.publicKey))
    expect(imported.algorithm.name).toBe('ECDH')
  })
})

describe('wrapDEK / unwrapDEK', () => {
  it('round-trips a DEK: data encrypted before wrap decrypts after unwrap', async () => {
    const ak = await generateAK()
    const dek = await generateDEK(true)
    const encrypted = await encrypt('dek round trip', dek)

    const unwrapped = await unwrapDEK(await wrapDEK(dek, ak, '0'), ak, '0')
    expect(unwrapped.extractable).toBe(false)
    expect([...unwrapped.usages].sort()).toEqual(['decrypt', 'encrypt'])
    expect(await decrypt(encrypted, unwrapped)).toBe('dek round trip')
  })

  it('fails to unwrap with a different AK', async () => {
    const ak1 = await generateAK()
    const ak2 = await generateAK()
    const wrapped = await wrapDEK(await generateDEK(true), ak1, '0')
    await expect(unwrapDEK(wrapped, ak2, '0')).rejects.toThrow('Failed to unwrap DEK')
  })

  it('fails to wrap a non-extractable DEK', async () => {
    const ak = await generateAK()
    const dek = await generateDEK()
    await expect(wrapDEK(dek, ak, '0')).rejects.toThrow('Failed to wrap DEK')
  })

  /**
   * THU-893 — the key_id is bound into the blob as AAD, so a keyring row served
   * under any OTHER key_id fails on the auth tag. This is what makes the
   * relabelling attack (the account's own "v1" blob served again under a
   * mintable id, steering new writes onto the never-rotating legacy CK)
   * cryptographically impossible, on every device, with no local state.
   */
  it('refuses to unwrap a blob under a different key_id than it was wrapped as (THU-893)', async () => {
    const ak = await generateAK()
    const wrappedAsV1 = await wrapDEK(await generateDEK(true), ak, 'v1')
    await expect(unwrapDEK(wrappedAsV1, ak, '1')).rejects.toThrow('Failed to unwrap DEK')
    await expect(unwrapDEK(wrappedAsV1, ak, '0')).rejects.toThrow('Failed to unwrap DEK')
    // The genuine label still opens — the binding, not the blob, is what changed.
    expect((await unwrapDEK(wrappedAsV1, ak, 'v1')).algorithm.name).toBe('AES-GCM')
  })

  it('produces different blobs for the same DEK (random IV, not deterministic AES-KW)', async () => {
    const ak = await generateAK()
    const dek = await generateDEK(true)
    expect(await wrapDEK(dek, ak, '0')).not.toBe(await wrapDEK(dek, ak, '0'))
  })
})

describe('mintDEK', () => {
  it('returns a non-extractable DEK that matches the wrapped blob', async () => {
    const ak = await generateAK()
    const { dek, wrappedKey } = await mintDEK(ak, '1')
    expect(dek.extractable).toBe(false)

    const encrypted = await encrypt('minted', dek)
    expect(await decrypt(encrypted, await unwrapDEK(wrappedKey, ak, '1'))).toBe('minted')
  })
})

describe('wrapAK / unwrapAK (v2 AEAD envelope, THU-890)', () => {
  it('round-trips AK + sealed pointer through wrap and unwrap', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const ak = await generateAK(true)

    const { ak: unwrapped, primaryKeyId } = await unwrapAK(
      await wrapAK(ak, ecdh.publicKey, mlkem.publicKey, '1'),
      ecdh.privateKey,
      mlkem.secretKey,
    )
    expect(primaryKeyId).toBe('1')
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
    expect(unwrapped.extractable).toBe(false)
    expect([...unwrapped.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('unwrapped AK unwraps a DEK wrapped by the original', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const dek = await generateDEK(true)

    const encrypted = await encrypt('wrap test', dek)
    const wrappedDek = await wrapDEK(dek, ak, '0')
    const { ak: unwrappedAk } = await unwrapAK(
      await wrapAK(ak, ecdh.publicKey, mlkem.publicKey, '0'),
      ecdh.privateKey,
      mlkem.secretKey,
    )
    expect(await decrypt(encrypted, await unwrapDEK(wrappedDek, unwrappedAk, '0'))).toBe('wrap test')
  })

  it('produces different wrapped values for the same key pair (ephemeral key)', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const ak = await generateAK(true)
    expect(await wrapAK(ak, ecdh.publicKey, mlkem.publicKey, '0')).not.toBe(
      await wrapAK(ak, ecdh.publicKey, mlkem.publicKey, '0'),
    )
  })

  it('emits the v2 envelope version byte', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const wrapped = await wrapAK(await generateAK(true), ecdh.publicKey, mlkem.publicKey, '0')
    expect(base64ToUint8Array(wrapped)[0]).toBe(0x02)
  })

  it('rejects a tampered pointer — the seal covers (AK, pointer) jointly', async () => {
    // The rollback move (THU-890): take a genuine current envelope and flip the
    // pointer bytes. The pointer sits INSIDE the AEAD, so any flip breaks the
    // tag — this is the property AES-KW could not provide.
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const wrapped = await wrapAK(await generateAK(true), ecdh.publicKey, mlkem.publicKey, '1')

    const envelope = base64ToUint8Array(wrapped)
    // The sealed payload's final byte is the pointer's last character.
    envelope[envelope.length - 1] ^= 0x01
    const tampered = btoa(String.fromCharCode(...envelope))

    await expect(unwrapAK(tampered, ecdh.privateKey, mlkem.secretKey)).rejects.toThrow('Failed to unwrap account key')
  })

  it('rejects a v1 (AES-KW) envelope — no silent downgrade to the pointerless layout', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const legacy = await wrapLegacyCK(await generateAK(true), ecdh.publicKey, mlkem.publicKey)
    await expect(unwrapAK(legacy, ecdh.privateKey, mlkem.secretKey)).rejects.toThrow('Unsupported AK envelope version')
  })
})

describe('rewrapAK', () => {
  it('rewrapped AK unwraps a DEK wrapped with the original, and the pointer travels unchanged', async () => {
    const ecdh1 = await generateKeyPair()
    const mlkem1 = generateMlKemKeyPair()
    const ecdh2 = await generateKeyPair()
    const mlkem2 = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const dek = await generateDEK(true)

    const encrypted = await encrypt('rewrap test', dek)
    const wrappedDek = await wrapDEK(dek, ak, '0')
    const wrappedAk = await wrapAK(ak, ecdh1.publicKey, mlkem1.publicKey, '3')
    const rewrapped = await rewrapAK(wrappedAk, ecdh1.privateKey, mlkem1.secretKey, ecdh2.publicKey, mlkem2.publicKey)
    const { ak: unwrappedAk, primaryKeyId } = await unwrapAK(rewrapped, ecdh2.privateKey, mlkem2.secretKey)
    expect(primaryKeyId).toBe('3')
    expect(await decrypt(encrypted, await unwrapDEK(wrappedDek, unwrappedAk, '0'))).toBe('rewrap test')
  })
})

describe('rewrapKeyring (AK rotation)', () => {
  it('re-wraps a 2-DEK keyring under a new AK, preserving key_ids and decryptability', async () => {
    const oldAK = await generateAK()
    const newAK = await generateAK()

    const { dek: dek0, wrappedKey: wrapped0 } = await mintDEK(oldAK, '0')
    const { dek: dek1, wrappedKey: wrapped1 } = await mintDEK(oldAK, 'v1')
    const value0 = await encrypt('value under key 0', dek0)
    const value1 = await encrypt('value under key 1', dek1)

    const { wrappedKeys: rewrapped, strandedKeyIds } = await rewrapKeyring(
      [
        { keyId: '0', wrappedKey: wrapped0 },
        { keyId: 'v1', wrappedKey: wrapped1 },
      ],
      oldAK,
      newAK,
    )

    expect(strandedKeyIds).toEqual([])
    expect(rewrapped.map((e) => e.keyId).sort()).toEqual(['0', 'v1'])
    const byId = Object.fromEntries(rewrapped.map((e) => [e.keyId, e.wrappedKey]))

    // Old AK can no longer unwrap the new blobs; new AK can.
    await expect(unwrapDEK(byId['0'], oldAK, '0')).rejects.toThrow('Failed to unwrap DEK')
    expect(await decrypt(value0, await unwrapDEK(byId['0'], newAK, '0'))).toBe('value under key 0')
    expect(await decrypt(value1, await unwrapDEK(byId['v1'], newAK, 'v1'))).toBe('value under key 1')
  })

  /**
   * THU-871: this used to be a bare `Promise.all`, so ONE unopenable row threw
   * the whole rotation. Since revocation IS an AK rotation, a single junk
   * `wrapped_keys` row permanently killed cryptographic revocation and "Change
   * Recovery Phrase" for that account.
   */
  it('passes an unopenable row through unchanged instead of failing the rotation', async () => {
    const oldAK = await generateAK()
    const newAK = await generateAK()
    const { dek: dek0, wrappedKey: wrapped0 } = await mintDEK(oldAK, '0')
    const value0 = await encrypt('value under key 0', dek0)
    // Wrapped under a key nobody on the account holds — the shape of a planted row.
    const { wrappedKey: junk } = await mintDEK(await generateAK(), '7')

    const { wrappedKeys, strandedKeyIds } = await rewrapKeyring(
      [
        { keyId: '0', wrappedKey: wrapped0 },
        { keyId: '7', wrappedKey: junk },
      ],
      oldAK,
      newAK,
    )

    expect(strandedKeyIds).toEqual(['7'])
    const byId = Object.fromEntries(wrappedKeys.map((e) => [e.keyId, e.wrappedKey]))
    // Every key_id survives — dropping one would strand its data, and the server
    // rejects a partial keyring anyway.
    expect(Object.keys(byId).sort()).toEqual(['0', '7'])
    // The stranded row keeps its ORIGINAL blob, so a device still holding the
    // key it was wrapped under can repair it by rotating again.
    expect(byId['7']).toBe(junk)
    // The good rows really did move to the new AK.
    expect(await decrypt(value0, await unwrapDEK(byId['0'], newAK, '0'))).toBe('value under key 0')
  })

  it('reports every key_id as stranded when none of them open', async () => {
    const { wrappedKey: junkA } = await mintDEK(await generateAK(), '0')
    const { wrappedKey: junkB } = await mintDEK(await generateAK(), 'v1')

    const { wrappedKeys, strandedKeyIds } = await rewrapKeyring(
      [
        { keyId: '0', wrappedKey: junkA },
        { keyId: 'v1', wrappedKey: junkB },
      ],
      await generateAK(),
      await generateAK(),
    )

    expect(strandedKeyIds.sort()).toEqual(['0', 'v1'])
    expect(wrappedKeys.map((e) => e.wrappedKey)).toEqual([junkA, junkB])
  })
})

describe('unwrapLegacyCK (WS3 absorption)', () => {
  it('unwraps a byte-identical v1 envelope into an extractable AES-GCM CK that decrypts a v1 value', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()

    // A v1 CK is an extractable AES-GCM key; `wrapLegacyCK` reproduces the
    // byte-identical v1 (AES-KW) envelope an old client would have written.
    const legacyCK = await generateDEK(true)
    const v1Value = await encrypt('legacy v1 secret', legacyCK) // v1 wrote with NO AAD
    const envelope = await wrapLegacyCK(legacyCK, ecdh.publicKey, mlkem.publicKey)

    const recovered = await unwrapLegacyCK(envelope, ecdh.privateKey, mlkem.secretKey)
    expect(recovered.algorithm.name).toBe('AES-GCM')
    expect(recovered.extractable).toBe(true)
    expect([...recovered.usages].sort()).toEqual(['decrypt', 'encrypt'])
    expect(await decrypt(v1Value, recovered)).toBe('legacy v1 secret')
  })

  it('fails to unwrap with the wrong device keys', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const wrongEcdh = await generateKeyPair()
    const wrongMlkem = generateMlKemKeyPair()
    const envelope = await wrapLegacyCK(await generateDEK(true), ecdh.publicKey, mlkem.publicKey)
    await expect(unwrapLegacyCK(envelope, wrongEcdh.privateKey, wrongMlkem.secretKey)).rejects.toThrow(
      'Failed to unwrap legacy content key',
    )
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips plaintext', async () => {
    const dek = await generateDEK()
    const encrypted = await encrypt('Hello, encryption!', dek)
    expect(await decrypt(encrypted, dek)).toBe('Hello, encryption!')
  })

  it('produces different ciphertext for the same plaintext (unique IV)', async () => {
    const dek = await generateDEK()
    const e1 = await encrypt('Same text', dek)
    const e2 = await encrypt('Same text', dek)
    expect(e1.ciphertext).not.toBe(e2.ciphertext)
  })

  it('fails to decrypt with a different key', async () => {
    const encrypted = await encrypt('secret', await generateDEK())
    await expect(decrypt(encrypted, await generateDEK())).rejects.toThrow('Failed to decrypt')
  })

  it('round-trips with additionalData (AAD)', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('tablecolumnrow-10')
    const encrypted = await encrypt('aad-bound', dek, aad)
    expect(await decrypt(encrypted, dek, aad)).toBe('aad-bound')
  })

  it('fails to decrypt without AAD when encrypted with AAD (and vice versa)', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('some-aad')
    await expect(decrypt(await encrypt('one', dek, aad), dek)).rejects.toThrow('Failed to decrypt')
    await expect(decrypt(await encrypt('two', dek), dek, aad)).rejects.toThrow('Failed to decrypt')
  })
})

describe('encryptBytes / decryptBytes', () => {
  it('round-trips raw bytes', async () => {
    const key = await generateDEK()
    const data = crypto.getRandomValues(new Uint8Array(100))
    const encrypted = await encryptBytes(data, key)
    expect(encrypted.iv.length).toBe(12)
    expect(encrypted.ciphertext).not.toEqual(data)
    expect(await decryptBytes(encrypted, key)).toEqual(data)
  })

  it('fails with a different key', async () => {
    const encrypted = await encryptBytes(new Uint8Array([1, 2, 3]), await generateDEK())
    await expect(decryptBytes(encrypted, await generateDEK())).rejects.toThrow('Failed to decrypt bytes')
  })
})

describe('importOrgPublicKey / wrapAKForOrg (THU-804 org escrow)', () => {
  // The inverse of wrapAKForOrg exists in the frontend ONLY here, for test
  // verification — production decryption lives in the offline operator tool.
  const unwrapOrgEnvelope = async (envelopeBase64: string, orgPrivateKey: CryptoKey): Promise<CryptoKey> => {
    const envelope = base64ToUint8Array(envelopeBase64)
    expect(envelope[0]).toBe(orgEnvelopeVersion)
    expect(envelope.length).toBe(1 + p256RawPublicKeyLength + 40)

    const ephPubRaw = envelope.slice(1, 1 + p256RawPublicKeyLength)
    const wrappedAKBytes = envelope.slice(1 + p256RawPublicKeyLength)
    const ephemeralPublicKey = await crypto.subtle.importKey(
      'raw',
      ephPubRaw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const ssEcdh = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeralPublicKey }, orgPrivateKey, 256)
    const hkdfKey = await crypto.subtle.importKey('raw', ssEcdh, 'HKDF', false, ['deriveKey'])
    const kwKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: ephPubRaw as BufferSource,
        info: new TextEncoder().encode(orgEscrowHkdfInfo),
      },
      hkdfKey,
      { name: 'AES-KW', length: 256 },
      false,
      ['unwrapKey'],
    )
    return crypto.subtle.unwrapKey('raw', wrappedAKBytes as BufferSource, kwKey, 'AES-KW', 'AES-GCM', true, [
      'wrapKey',
      'unwrapKey',
    ])
  }

  it('round-trips the AK through the org envelope (inverted locally in the test)', async () => {
    const orgKeys = await generateKeyPair()
    const orgPublicKey = await importOrgPublicKey(await exportPublicKey(orgKeys.publicKey))
    const ak = await generateAK(true)

    const recovered = await unwrapOrgEnvelope(await wrapAKForOrg(ak, orgPublicKey), orgKeys.privateKey)
    const akRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ak))
    const recoveredRaw = new Uint8Array(await crypto.subtle.exportKey('raw', recovered))
    expect(recoveredRaw).toEqual(akRaw)
  })

  it('rejects a wrong-length org public key', async () => {
    const tooShort = uint8ArrayToBase64(new Uint8Array(64))
    await expect(importOrgPublicKey(tooShort)).rejects.toThrow('Invalid org public key: 64 bytes, expected 65')
  })

  it('produces different envelopes per wrap (fresh ephemeral) that invert to the same AK', async () => {
    const orgKeys = await generateKeyPair()
    const orgPublicKey = await importOrgPublicKey(await exportPublicKey(orgKeys.publicKey))
    const ak = await generateAK(true)

    const envelope1 = await wrapAKForOrg(ak, orgPublicKey)
    const envelope2 = await wrapAKForOrg(ak, orgPublicKey)
    expect(envelope1).not.toBe(envelope2)

    const akRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ak))
    for (const envelope of [envelope1, envelope2]) {
      const recovered = await unwrapOrgEnvelope(envelope, orgKeys.privateKey)
      expect(new Uint8Array(await crypto.subtle.exportKey('raw', recovered))).toEqual(akRaw)
    }
  })
})

describe('deriveMlKemAtRestKey', () => {
  it('derives the same key from the same ECDH pair (deterministic self-ECDH)', async () => {
    const keyPair = await generateKeyPair()
    const key1 = await deriveMlKemAtRestKey(keyPair.publicKey, keyPair.privateKey)
    const key2 = await deriveMlKemAtRestKey(keyPair.publicKey, keyPair.privateKey)
    expect(await decryptBytes(await encryptBytes(new Uint8Array([9, 8, 7]), key1), key2)).toEqual(
      new Uint8Array([9, 8, 7]),
    )
  })

  it('derives different keys for different ECDH pairs (sk unreadable without self-ECDH)', async () => {
    const keyPair1 = await generateKeyPair()
    const keyPair2 = await generateKeyPair()
    const key1 = await deriveMlKemAtRestKey(keyPair1.publicKey, keyPair1.privateKey)
    const key2 = await deriveMlKemAtRestKey(keyPair2.publicKey, keyPair2.privateKey)
    await expect(decryptBytes(await encryptBytes(new Uint8Array([1, 2, 3]), key1), key2)).rejects.toThrow(
      'Failed to decrypt bytes',
    )
  })
})
