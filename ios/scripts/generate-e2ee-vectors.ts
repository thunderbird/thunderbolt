/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)
const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64')
const b64url = (value: Uint8Array): string => Buffer.from(value).toString('base64url')
const concat = (...values: Uint8Array[]): Uint8Array => Uint8Array.from(values.flatMap((value) => [...value]))
const privateJWK = (scalar: Uint8Array) => {
  const publicKey = p256.getPublicKey(scalar, false)
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: b64url(publicKey.slice(1, 33)), y: b64url(publicKey.slice(33, 65)), d: b64url(scalar), ext: true, key_ops: ['deriveBits'] },
    publicKey,
  }
}

const recipientScalar = bytes(32, 0)
recipientScalar[31] = 1
const ephemeralScalar = bytes(32, 0)
ephemeralScalar[31] = 2
const recipient = privateJWK(recipientScalar)
const ephemeral = privateJWK(ephemeralScalar)
const kemSeed = bytes(64, 0x11)
const kem = ml_kem768.keygen(kemSeed)
const kemRandomness = bytes(32, 0x22)
const kemResult = ml_kem768.encapsulate(kem.publicKey, kemRandomness)
const ephemeralPrivate = await crypto.subtle.importKey('jwk', ephemeral.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
const recipientPublic = await crypto.subtle.importKey('raw', recipient.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
const ecdhShared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientPublic }, ephemeralPrivate, 256))
const salt = concat(ephemeral.publicKey, kemResult.cipherText)
const ikm = concat(ecdhShared, kemResult.sharedSecret)
const hkdf = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
const sealKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('thunderbolt-hybrid-ak-seal-v2') },
  hkdf,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
)
const accountKey = bytes(32, 0xaa)
const keyVersion = Uint8Array.from([1, 2, 3, 4])
const keyID = new TextEncoder().encode('17')
const payload = concat(accountKey, keyVersion, keyID)
const envelopeIV = bytes(12, 0x33)
const envelopeCiphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: envelopeIV, additionalData: Uint8Array.from([3]) }, sealKey, payload))
const envelope = concat(Uint8Array.from([3]), ephemeral.publicKey, kemResult.cipherText, envelopeIV, envelopeCiphertext)
const openedPayload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelopeIV, additionalData: Uint8Array.from([3]) }, sealKey, envelopeCiphertext))
if (b64(openedPayload) !== b64(payload)) throw new Error('AK envelope fixture failed its TypeScript self-check')

const dataKey = bytes(32, 0xbb)
const dataKeyIV = bytes(12, 0xcc)
const ak = await crypto.subtle.importKey('raw', accountKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
const wrappedDEK = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dataKeyIV, additionalData: new TextEncoder().encode('__kw\u001f17') }, ak, dataKey))
const decodedDEK = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dataKeyIV, additionalData: new TextEncoder().encode('__kw\u001f17') }, ak, wrappedDEK))
if (b64(decodedDEK) !== b64(dataKey)) throw new Error('DEK fixture failed its TypeScript self-check')

const fixture = {
  source: 'TypeScript WebCrypto + Noble ML-KEM-768 interoperability vector',
  device: {
    ecdhPrivateKeyRaw: b64(recipientScalar),
    ecdhPublicKeyRaw: b64(recipient.publicKey),
    mlkemPublicKey: b64(kem.publicKey),
    mlkemSecretKey: b64(kem.secretKey),
  },
  envelope: {
    accountKey: b64(accountKey),
    primaryKeyID: '17',
    keyVersion: 16909060,
    ephemeralECDHPrivateKeyRaw: b64(ephemeralScalar),
    mlkemRandomness: b64(kemRandomness),
    iv: b64(envelopeIV),
    wrappedAK: b64(envelope),
  },
  dek: {
    accountKey: b64(accountKey),
    dataKey: b64(dataKey),
    keyID: '17',
    iv: b64(dataKeyIV),
    wrappedKey: b64(concat(dataKeyIV, wrappedDEK)),
  },
}

const fixturePath = 'ios/ThunderboltTests/Fixtures/e2ee-vectors.json'
await Bun.write(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`Wrote ${fixturePath}`)
