/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { kdfAlgorithm, kdfHash, kdfIterations, kdfSaltLength } from '@shared/e2ee-types'

import { continuityHolds, deriveContinuityKey, sealContinuity, type ContinuitySealScope } from './continuity-seal'
import { KeyDerivationError, ValidationError } from './errors'
import { continuitySaltTag } from './kdf-salt'
import type { StoredKeyPair } from './key-storage'
import { base64ToUint8Array, importPublicKey, uint8ArrayToBase64, uint8ArrayToBase64Url } from './primitives'

export { kdfSaltRequiresContinuity } from './kdf-salt'

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
const continuityHkdfInfo = new TextEncoder().encode('thunderbolt-recovery-continuity-key-v1')

// The continuity seal's scope is a wire contract too: every recovery reads it.
const recoveryContinuityScope: ContinuitySealScope = {
  domain: 'thunderbolt-recovery-continuity-v1',
  aadColumn: 'recovery_continuity',
  plaintext: 'thunderbolt-recovery-continuity',
  binding: [],
}

/** The recovery keypair plus the phrase's continuity key (HMAC-SHA256, sign/verify only). */
export type RecoveryKeyPair = StoredKeyPair & { continuityKey: CryptoKey }

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

/**
 * Deterministically derive the recovery slot's hybrid keypair from the recovery
 * seed — the recovery phrase is a virtual device, and this is its key material.
 * A superset of `StoredKeyPair`, so it drops straight into `wrapAK`/`unwrapAK`.
 *
 * seed --PBKDF2-SHA512 600k, salt=kdf_salt--> 64-byte master
 *      --HKDF-SHA256, info='…-ecdh-v1'-----> 48 bytes -> P-256 scalar
 *      --HKDF-SHA256, info='…-mlkem-v1'----> 64 bytes -> ML-KEM-768 seed
 *      --HKDF-SHA256, info='…-continuity-key-v1'--> HMAC key for `sealRecoveryContinuity`
 *
 * The 48-byte ECDH sub-seed is noble's bias-free hash-to-scalar width
 * (`getMinHashLength(n)`), which reduces into [1, n-1] deterministically — no
 * randomized retry, so a given phrase yields the same keypair forever.
 */
export const deriveRecoveryKeyPairFromSeed = async (seed: Uint8Array, saltBase64: string): Promise<RecoveryKeyPair> => {
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
    const masterKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey'])
    const continuityKey = await deriveContinuityKey(masterKey, continuityHkdfInfo)
    return { ...(await deriveHybridKeyPair(masterKey, { ecdh: ecdhHkdfInfo, mlkem: mlkemHkdfInfo })), continuityKey }
  } catch (err) {
    throw new KeyDerivationError('Failed to derive recovery keypair from recovery seed', { cause: err })
  }
}

/**
 * Generate a per-account KDF salt, base64-encoded (stored server-side as
 * `kdf_salt`): `continuitySaltTag` followed by random bytes.
 *
 * The tag says "this phrase has a continuity seal", and it can be trusted on a
 * wiped device because recovery only proceeds when the phrase and this salt
 * re-derive the stored public keys. A server that swaps in an untagged salt to
 * skip the seal breaks that match unless it knows the phrase. The 24 random
 * bytes left are still far more than a salt needs.
 */
export const generateKdfSalt = (): string => {
  const salt = crypto.getRandomValues(new Uint8Array(kdfSaltLength))
  salt.set(continuitySaltTag)
  return uint8ArrayToBase64(salt)
}

/**
 * Bind DEK `"0"` to the recovery phrase: a fixed-plaintext sample under DEK
 * `"0"`, MACed with the phrase's continuity key. Stored server-side as
 * `recovery_continuity` and written only where the phrase is minted (setup,
 * phrase change, v1 → v2 upgrade). DEK `"0"` never changes, so rotations keep it.
 *
 * Recovery cannot trust the AK it opens: anyone can wrap an AK to the stored
 * recovery PUBLIC keys. Making the sample needs DEK `"0"` and MACing it needs the
 * phrase, so a server holding neither cannot pass off its own key set as the
 * account's. The MAC sits over the sample rather than inside it so that holders
 * of DEK `"0"`, revoked devices included, learn nothing about the phrase key.
 */
export const sealRecoveryContinuity = (dek0: CryptoKey, continuityKey: CryptoKey, userId: string): Promise<string> =>
  sealContinuity(dek0, continuityKey, userId, recoveryContinuityScope)

/**
 * Does the served seal hold for this candidate DEK `"0"`? Fails closed: a
 * missing, malformed, foreign or forged seal all return false.
 */
export const recoveryContinuityHolds = (
  sealed: string | null,
  dek0: CryptoKey,
  continuityKey: CryptoKey,
  userId: string,
): Promise<boolean> => continuityHolds(sealed, dek0, continuityKey, userId, recoveryContinuityScope)
