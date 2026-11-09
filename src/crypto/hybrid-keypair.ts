/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

import type { StoredKeyPair } from './key-storage'
import { importPublicKey, uint8ArrayToBase64, uint8ArrayToBase64Url } from './primitives'

// Every constant below is a wire contract: changing one re-derives a different
// keypair from the same secret and bricks every recovery phrase, passkey slot
// and inbox key derived with it. Kept apart from the recovery phrase's BIP-39
// code so the inbox-key check at start does not load the wordlist.
const ecdhCurve = 'P-256'
const hkdfHash = 'SHA-256'
const ecdhSeedLength = 48 // getMinHashLength(P-256 order) — noble's bias-free scalar width
const mlkemSeedLength = 64 // ML-KEM-768 keygen seed (d || z)

/**
 * Expand the PBKDF2 master secret into one domain-separated sub-seed. HKDF-SHA256
 * with a distinct `info` label per key type is what keeps the ECDH scalar and the
 * ML-KEM seed independent — never feed the master secret to both directly.
 */
const expandSubSeed = async (masterKey: CryptoKey, info: Uint8Array, byteLength: number): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: hkdfHash, salt: new Uint8Array(0), info: info as BufferSource },
      masterKey,
      byteLength * 8,
    ),
  )

/**
 * Import a raw P-256 scalar as a WebCrypto ECDH private key. WebCrypto cannot
 * seed-derive EC keys, so the scalar comes from noble and is handed back through
 * JWK — the only import format that carries a private scalar.
 */
const importEcdhPrivateKey = async (privateScalar: Uint8Array, publicKeyRaw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: ecdhCurve,
      d: uint8ArrayToBase64Url(privateScalar),
      x: uint8ArrayToBase64Url(publicKeyRaw.slice(1, 33)),
      y: uint8ArrayToBase64Url(publicKeyRaw.slice(33, 65)),
      ext: false,
    },
    { name: 'ECDH', namedCurve: ecdhCurve },
    false,
    ['deriveBits'],
  )

/**
 * Derive a hybrid keypair (ECDH P-256 + ML-KEM-768) from an HKDF master key, one
 * HKDF-SHA256 sub-seed per key type. Shared by every virtual device: the
 * recovery phrase and the passkey slot differ only in where the master secret
 * comes from and in their `info` labels, which keep their keypairs independent.
 */
export const deriveHybridKeyPair = async (
  masterKey: CryptoKey,
  labels: { ecdh: Uint8Array; mlkem: Uint8Array },
): Promise<StoredKeyPair> => {
  const ecdhSeed = await expandSubSeed(masterKey, labels.ecdh, ecdhSeedLength)
  const ecdhPrivateScalar = p256.utils.randomSecretKey(ecdhSeed)
  const ecdhPublicKeyRaw = p256.getPublicKey(ecdhPrivateScalar, false)

  const mlkemSeed = await expandSubSeed(masterKey, labels.mlkem, mlkemSeedLength)
  const { publicKey: mlkemPublicKey, secretKey: mlkemSecretKey } = ml_kem768.keygen(mlkemSeed)

  return {
    ecdhPrivateKey: await importEcdhPrivateKey(ecdhPrivateScalar, ecdhPublicKeyRaw),
    ecdhPublicKey: await importPublicKey(uint8ArrayToBase64(ecdhPublicKeyRaw)),
    mlkemPublicKey,
    mlkemSecretKey,
  }
}
