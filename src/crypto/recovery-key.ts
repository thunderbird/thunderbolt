/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { kdfAlgorithm, kdfHash, kdfIterations, kdfSaltLength } from '@shared/e2ee-types'

import { KeyDerivationError, ValidationError } from './errors'
import type { StoredKeyPair } from './key-storage'
import { base64ToUint8Array, importPublicKey, uint8ArrayToBase64 } from './primitives'

const seedLength = 32 // bytes → 24 BIP-39 words

// Recovery keypair derivation — every constant below is a wire contract. Changing
// any of them re-derives a different keypair and bricks every existing phrase.
const ecdhCurve = 'P-256'
const hkdfHash = 'SHA-256'
const masterSecretLength = 64 // one PBKDF2-SHA512 block — a wider ask doubles the 600k cost
const ecdhSeedLength = 48 // getMinHashLength(P-256 order) — noble's bias-free scalar width
const mlkemSeedLength = 64 // ML-KEM-768 keygen seed (d || z)
const ecdhHkdfInfo = new TextEncoder().encode('thunderbolt-recovery-ecdh-v1')
const mlkemHkdfInfo = new TextEncoder().encode('thunderbolt-recovery-mlkem-v1')

/** Generate a random 256-bit recovery seed (the value the 24 words encode). */
export const generateRecoverySeed = (): Uint8Array => crypto.getRandomValues(new Uint8Array(seedLength))

/** Encode a recovery seed as a 24-word BIP-39 mnemonic (recovery phrase). */
export const encodeRecoverySeed = (seed: Uint8Array): string => entropyToMnemonic(seed, wordlist)

/**
 * Decode a 24-word BIP-39 mnemonic into the recovery seed (checksum-validated).
 * Seed only — deriving the recovery keypair is a separate
 * `deriveRecoveryKeyPairFromSeed` call that needs the server-stored `kdf_salt`.
 */
export const decodeRecoveryKey = (mnemonic: string): Uint8Array => {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')

  let bytes: Uint8Array
  try {
    bytes = mnemonicToEntropy(normalized, wordlist)
  } catch {
    throw new ValidationError(
      'Invalid recovery phrase. Please check that all 24 words are correct and in the right order.',
    )
  }

  if (bytes.length !== seedLength) {
    throw new ValidationError('Recovery phrase must be exactly 24 words (256-bit key).')
  }

  return bytes
}

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

/** base64url-encode without padding (JWK field encoding, RFC 7515 §2). */
const toBase64Url = (bytes: Uint8Array): string =>
  uint8ArrayToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

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
      d: toBase64Url(privateScalar),
      x: toBase64Url(publicKeyRaw.slice(1, 33)),
      y: toBase64Url(publicKeyRaw.slice(33, 65)),
      ext: false,
    },
    { name: 'ECDH', namedCurve: ecdhCurve },
    false,
    ['deriveBits'],
  )

/**
 * Deterministically derive the recovery slot's hybrid keypair from the recovery
 * seed — the recovery phrase is a virtual device, and this is its key material.
 * Same shape as `StoredKeyPair`, so it drops straight into `wrapAK`/`unwrapAK`.
 *
 * seed --PBKDF2-SHA512 600k, salt=kdf_salt--> 64-byte master
 *      --HKDF-SHA256, info='…-ecdh-v1'-----> 48 bytes -> P-256 scalar
 *      --HKDF-SHA256, info='…-mlkem-v1'----> 64 bytes -> ML-KEM-768 seed
 *
 * The 48-byte ECDH sub-seed is noble's bias-free hash-to-scalar width
 * (`getMinHashLength(n)`), which reduces into [1, n-1] deterministically — no
 * randomized retry, so a given phrase yields the same keypair forever.
 */
export const deriveRecoveryKeyPairFromSeed = async (seed: Uint8Array, saltBase64: string): Promise<StoredKeyPair> => {
  try {
    const baseKey = await crypto.subtle.importKey('raw', seed as BufferSource, kdfAlgorithm, false, ['deriveBits'])
    const master = await crypto.subtle.deriveBits(
      {
        name: kdfAlgorithm,
        hash: kdfHash,
        salt: base64ToUint8Array(saltBase64),
        iterations: kdfIterations,
      },
      baseKey,
      masterSecretLength * 8,
    )
    const masterKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits'])

    const ecdhSeed = await expandSubSeed(masterKey, ecdhHkdfInfo, ecdhSeedLength)
    const ecdhPrivateScalar = p256.utils.randomSecretKey(ecdhSeed)
    const ecdhPublicKeyRaw = p256.getPublicKey(ecdhPrivateScalar, false)

    const mlkemSeed = await expandSubSeed(masterKey, mlkemHkdfInfo, mlkemSeedLength)
    const { publicKey: mlkemPublicKey, secretKey: mlkemSecretKey } = ml_kem768.keygen(mlkemSeed)

    return {
      ecdhPrivateKey: await importEcdhPrivateKey(ecdhPrivateScalar, ecdhPublicKeyRaw),
      ecdhPublicKey: await importPublicKey(uint8ArrayToBase64(ecdhPublicKeyRaw)),
      mlkemPublicKey,
      mlkemSecretKey,
    }
  } catch (err) {
    throw new KeyDerivationError('Failed to derive recovery keypair from recovery seed', { cause: err })
  }
}

/** Generate a random per-account KDF salt, base64-encoded (stored server-side as `kdf_salt`). */
export const generateKdfSalt = (): string => uint8ArrayToBase64(crypto.getRandomValues(new Uint8Array(kdfSaltLength)))
