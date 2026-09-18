/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import {
  dekWrapAAD,
  orgEnvelopeVersion,
  orgEscrowHkdfInfo,
  p256RawPublicKeyLength,
  type KeyId,
} from '@shared/e2ee-types'
import { DecryptionError, EncryptionError } from './errors'

const ecdhAlgorithm = 'ECDH'
const ecdhCurve = 'P-256'
const ephemeralPubKeyLength = 65 // P-256 uncompressed: 0x04 || x (32) || y (32)
export const aesGcmAlgorithm = 'AES-GCM'
const aesKwAlgorithm = 'AES-KW'
const aesKeyLength = 256
export const ivLength = 12
const hkdfHash = 'SHA-256'

// Hybrid envelope constants — byte layout is a wire contract, never change.
// v1 (0x01): [version][ephPub 65][mlkemCt 1088][AES-KW(key) 40] — the legacy CK
// envelope, still read by `unwrapLegacyCK` for the v1→v2 absorption, and still
// WRITTEN only by the e2e harness when it seeds a legacy account.
// v2 (0x02): [version][ephPub 65][mlkemCt 1088][iv 12][AES-GCM(rawAK ‖ pointer)]
// — the AK envelope (THU-890). The pointer rides INSIDE the AEAD so the GCM tag
// covers (AK, primary_key_id) jointly: a server cannot re-pair the account's
// real AK with a pointer of its choosing, because it never holds a cleartext AK
// and any byte it flips breaks the tag. AES-KW could not do this — it takes no
// AAD and wraps only bare key material, which is exactly why appending a
// pointer to the v1 layout would have left it malleable.
const envelopeVersion = 0x01
const akEnvelopeVersion = 0x02
const mlkemCiphertextLength = 1088
const aesKwWrappedKeyLength = 40 // AES-KW(256-bit key) = 32 + 8
const minEnvelopeLength = 1 + ephemeralPubKeyLength + mlkemCiphertextLength + aesKwWrappedKeyLength
const rawAkLength = 32
const gcmTagLength = 16
// AK(32) + at least one pointer character + the GCM tag.
const minAkEnvelopeLength =
  1 + ephemeralPubKeyLength + mlkemCiphertextLength + ivLength + rawAkLength + 1 + gcmTagLength
const hybridHkdfInfo = new TextEncoder().encode('thunderbolt-hybrid-ck-wrap-v1')
// Distinct info for the v2 AEAD seal — the derived key drives a different
// algorithm (AES-GCM vs AES-KW), so it gets its own derivation domain.
const hybridSealHkdfInfo = new TextEncoder().encode('thunderbolt-hybrid-ak-seal-v2')
/** The version byte doubles as the seal's AAD — parsing and AEAD must agree. */
const akEnvelopeAad = new Uint8Array([akEnvelopeVersion])

const mlkemAtRestHkdfInfo = new TextEncoder().encode('thunderbolt-mlkem-at-rest-v1')

const orgEscrowHkdfInfoBytes = new TextEncoder().encode(orgEscrowHkdfInfo)

// =============================================================================
// ECDH key pair (for wrapping/unwrapping AK via ECIES)
// =============================================================================

/** Generate an ECDH P-256 key pair for wrapping/unwrapping AK. */
export const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey({ name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, ['deriveBits'])

/** Export a public key to base64 (for sending to the server). */
export const exportPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey('raw', publicKey)
  return uint8ArrayToBase64(new Uint8Array(exported))
}

/** Import a public key from base64 (for wrapping AK with another device's key). */
export const importPublicKey = async (base64: string): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.importKey(
      'raw',
      base64ToUint8Array(base64),
      { name: ecdhAlgorithm, namedCurve: ecdhCurve },
      true,
      [],
    )
  } catch (err) {
    throw new EncryptionError('Failed to import public key', { cause: err })
  }
}

// =============================================================================
// ML-KEM-768 key pair (post-quantum, for hybrid wrapping)
// =============================================================================

export type MlKemKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

/** Generate an ML-KEM-768 key pair for hybrid AK wrapping. */
export const generateMlKemKeyPair = (): MlKemKeyPair => {
  const { publicKey, secretKey } = ml_kem768.keygen()
  return { publicKey, secretKey }
}

/** Export an ML-KEM public key to base64. */
export const exportMlKemPublicKey = (publicKey: Uint8Array): string => uint8ArrayToBase64(publicKey)

/** Import an ML-KEM public key from base64. */
export const importMlKemPublicKey = (base64: string): Uint8Array => base64ToUint8Array(base64)

/**
 * Derive the AES-GCM key that encrypts the ML-KEM secret key at rest (THU-427).
 * Self-ECDH (own public + own private) → HKDF-SHA256 — NOT the AK, which would
 * be a circular dependency (the AK envelope needs the ML-KEM secret to unwrap).
 * The ECDH private key is a non-extractable CryptoKey in IndexedDB, so this
 * raises the bar from plaintext-bytes-at-rest.
 */
export const deriveMlKemAtRestKey = async (
  ownEcdhPublicKey: CryptoKey,
  ownEcdhPrivateKey: CryptoKey,
): Promise<CryptoKey> => {
  const shared = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ownEcdhPublicKey },
    ownEcdhPrivateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: new Uint8Array(0), info: mlkemAtRestHkdfInfo },
    hkdfKey,
    { name: aesGcmAlgorithm, length: aesKeyLength },
    false,
    ['encrypt', 'decrypt'],
  )
}

// =============================================================================
// AK (Account Key, AES-GCM wrap-only) + DEK (Data Encryption Key, AES-GCM)
// =============================================================================

/**
 * Generate an Account Key: AES-GCM 256, `wrapKey`/`unwrapKey` ONLY — it must be
 * unable to encrypt data (access control, not data encryption).
 *
 * AES-GCM rather than AES-KW because DEK wrapping binds the `key_id` into the
 * blob as AAD (THU-893, see `wrapDEK`) and AES-KW takes no AAD. The wrap-only
 * usages are what keep the AK out of the data plane despite sharing GCM with
 * the DEKs.
 * @param extractable - `true` only transiently during setup (the AK must be
 *   extractable to be wrapped into device envelopes). Re-import via
 *   `reimportAsNonExtractable` before storing.
 */
export const generateAK = async (extractable = false): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: aesGcmAlgorithm, length: aesKeyLength }, extractable, ['wrapKey', 'unwrapKey'])

/** Re-import an extractable AK as non-extractable. Used after setup wrapping. */
export const reimportAsNonExtractable = async (ak: CryptoKey): Promise<CryptoKey> => {
  const raw = await crypto.subtle.exportKey('raw', ak)
  return crypto.subtle.importKey('raw', raw, { name: aesGcmAlgorithm, length: aesKeyLength }, false, [
    'wrapKey',
    'unwrapKey',
  ])
}

/**
 * Generate a Data Encryption Key: AES-256-GCM, `encrypt`/`decrypt`.
 * @param extractable - `true` only transiently at mint time (WebCrypto wrapKey
 *   requires the wrapped key extractable). Prefer `mintDEK`, which never lets
 *   the extractable copy escape.
 */
export const generateDEK = async (extractable = false): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: aesGcmAlgorithm, length: aesKeyLength }, extractable, ['encrypt', 'decrypt'])

/**
 * Wrap a DEK under the AK with AES-GCM, binding `keyId` into the blob as AAD
 * (THU-893 — see `dekWrapAAD`). The blob is base64(`iv(12) ‖ ciphertext‖tag`),
 * so a keyring row served under any OTHER key_id fails to unwrap on the auth
 * tag: relabelling a blob is cryptographically impossible, with no local state
 * and nothing for a malicious server to withhold. The DEK must be extractable
 * at wrap time.
 */
export const wrapDEK = async (dek: CryptoKey, ak: CryptoKey, keyId: string): Promise<string> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const wrapped = new Uint8Array(
      await crypto.subtle.wrapKey('raw', dek, ak, {
        name: aesGcmAlgorithm,
        iv,
        additionalData: dekWrapAAD(keyId) as BufferSource,
      }),
    )
    const blob = new Uint8Array(iv.length + wrapped.length)
    blob.set(iv, 0)
    blob.set(wrapped, iv.length)
    return uint8ArrayToBase64(blob)
  } catch (err) {
    throw new EncryptionError('Failed to wrap DEK', { cause: err })
  }
}

/**
 * Unwrap a wrapped DEK (base64) under the AK. `keyId` MUST be the id the caller
 * is resolving the row AS (its keyring label / the wire key_id) — never a
 * separately server-supplied value — so a blob created under a different id
 * fails here (THU-893). Non-extractable by default.
 */
export const unwrapDEK = async (
  wrappedBase64: string,
  ak: CryptoKey,
  keyId: string,
  extractable = false,
): Promise<CryptoKey> => {
  try {
    const blob = base64ToUint8Array(wrappedBase64)
    const iv = blob.slice(0, ivLength)
    const wrapped = blob.slice(ivLength)
    return await crypto.subtle.unwrapKey(
      'raw',
      wrapped as BufferSource,
      ak,
      { name: aesGcmAlgorithm, iv: iv as BufferSource, additionalData: dekWrapAAD(keyId) as BufferSource },
      { name: aesGcmAlgorithm, length: aesKeyLength },
      extractable,
      ['encrypt', 'decrypt'],
    )
  } catch (err) {
    throw new DecryptionError('Failed to unwrap DEK', { cause: err })
  }
}

/**
 * Mint a new DEK already wrapped under the AK as `keyId`. The extractable copy
 * exists only inside this function; the returned `dek` is the non-extractable
 * unwrap of the returned `wrappedKey` (single source of truth).
 */
export const mintDEK = async (ak: CryptoKey, keyId: string): Promise<{ dek: CryptoKey; wrappedKey: string }> => {
  const extractableDek = await generateDEK(true)
  const wrappedKey = await wrapDEK(extractableDek, ak, keyId)
  const dek = await unwrapDEK(wrappedKey, ak, keyId)
  return { dek, wrappedKey }
}

/** Outcome of one keyring re-wrap: every key_id, plus which ones could not be opened. */
export type RewrapKeyringResult = {
  /** Every input key_id — re-wrapped under the new AK, or passed through unchanged if stranded. */
  wrappedKeys: Array<{ keyId: string; wrappedKey: string }>
  /** key_ids whose old wrapping would not open, so their blob was passed through as-is. */
  strandedKeyIds: string[]
}

/**
 * Re-wrap an entire DEK keyring under a NEW AK (AK rotation, plan §2.4). Each
 * DEK is unwrapped temporarily-extractable in-memory under the old AK and
 * re-wrapped under the new AK; no persistent extractable copy is ever produced.
 * The set of `keyId`s is preserved exactly — dropping any (esp. the `"v1"` slot)
 * would strand data (Risk 1), so callers validate coverage against this output.
 *
 * NON-FATAL on a row that will not open (THU-871). This used to be a bare
 * `Promise.all`, so a single unopenable row threw the whole rotation — and since
 * revocation IS an AK rotation, one junk `wrapped_keys` row (planted by a
 * malicious server, or left behind by a trusted device) permanently killed
 * cryptographic revocation and "Change Recovery Phrase" on that account.
 *
 * Such a row is passed through with its ORIGINAL blob and reported in
 * `strandedKeyIds`. Pass-through, not omission and not deletion: the row keeps
 * its (key_id, DEK) slot, so a device that still holds the old AK and its own
 * staged copy can repair it later by re-wrapping and rotating again — a delete
 * would turn recoverable damage into permanent loss, and the server cannot
 * verify a claim that a row is junk in the first place. It is also
 * information-neutral: the blob was already unopenable under the current AK.
 *
 * Callers MUST decide what a stranded `"0"` means (see `runAKRotation`): DEK '0'
 * failing to open is the signature of a STALE AK, not of a poisoned keyring.
 */
export const rewrapKeyring = async (
  wrappedKeys: Array<{ keyId: string; wrappedKey: string }>,
  oldAK: CryptoKey,
  newAK: CryptoKey,
): Promise<RewrapKeyringResult> => {
  try {
    const strandedKeyIds: string[] = []
    const rewrapped = await Promise.all(
      wrappedKeys.map(async ({ keyId, wrappedKey }) => {
        const tempDek = await unwrapDEK(wrappedKey, oldAK, keyId, true).catch(() => null)
        if (!tempDek) {
          strandedKeyIds.push(keyId)
          return { keyId, wrappedKey }
        }
        return { keyId, wrappedKey: await wrapDEK(tempDek, newAK, keyId) }
      }),
    )
    return { wrappedKeys: rewrapped, strandedKeyIds }
  } catch (err) {
    if (err instanceof EncryptionError || err instanceof DecryptionError) {
      throw err
    }
    throw new EncryptionError('Failed to re-wrap keyring', { cause: err })
  }
}

// =============================================================================
// Hybrid ECIES: Wrap / Unwrap AK with ECDH P-256 + ML-KEM-768 + HKDF + AES-KW
//
// Combines a classical ECDH shared secret with an ML-KEM-768 shared secret via
// HKDF, following the combiner pattern from Signal PQXDH and IETF hybrid guidelines.
// Security holds as long as at least one of the two KEMs is unbroken.
// =============================================================================

/**
 * Derive an AES-KW-256 wrapping key from the hybrid shared secrets via HKDF.
 * ikm = ss_ecdh || ss_mlkem (64 bytes combined)
 * salt = ephPubRaw || mlkemCiphertext (binds derivation to both KEM transcripts)
 */
const hybridHkdfInputs = async (
  ssEcdh: ArrayBuffer,
  ssMlkem: Uint8Array,
  ephPubRaw: Uint8Array,
  mlkemCiphertext: Uint8Array,
): Promise<{ hkdfKey: CryptoKey; salt: Uint8Array }> => {
  // Concatenate both shared secrets as IKM
  const combinedSS = new Uint8Array(32 + 32)
  combinedSS.set(new Uint8Array(ssEcdh), 0)
  combinedSS.set(ssMlkem, 32)

  // Bind to both KEM transcripts via salt
  const salt = new Uint8Array(ephPubRaw.length + mlkemCiphertext.length)
  salt.set(ephPubRaw, 0)
  salt.set(mlkemCiphertext, ephPubRaw.length)

  return { hkdfKey: await crypto.subtle.importKey('raw', combinedSS, 'HKDF', false, ['deriveKey']), salt }
}

const deriveHybridWrappingKey = async (
  ssEcdh: ArrayBuffer,
  ssMlkem: Uint8Array,
  ephPubRaw: Uint8Array,
  mlkemCiphertext: Uint8Array,
  usage: 'wrapKey' | 'unwrapKey',
): Promise<CryptoKey> => {
  const { hkdfKey, salt } = await hybridHkdfInputs(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext)
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: salt as BufferSource, info: hybridHkdfInfo },
    hkdfKey,
    { name: aesKwAlgorithm, length: 256 },
    false,
    [usage],
  )
}

/** The v2 counterpart: an AES-GCM key for the AK envelope's AEAD seal. */
const deriveHybridSealKey = async (
  ssEcdh: ArrayBuffer,
  ssMlkem: Uint8Array,
  ephPubRaw: Uint8Array,
  mlkemCiphertext: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> => {
  const { hkdfKey, salt } = await hybridHkdfInputs(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext)
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: salt as BufferSource, info: hybridSealHkdfInfo },
    hkdfKey,
    { name: aesGcmAlgorithm, length: aesKeyLength },
    false,
    [usage],
  )
}

/** Fresh hybrid transcript for one envelope: ephemeral ECDH + ML-KEM encapsulation. */
const beginHybridSeal = async (
  ecdhPublicKey: CryptoKey,
  mlkemPublicKey: Uint8Array,
): Promise<{ ephPubRaw: Uint8Array; mlkemCiphertext: Uint8Array; ssEcdh: ArrayBuffer; ssMlkem: Uint8Array }> => {
  const ephemeral = await crypto.subtle.generateKey({ name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, [
    'deriveBits',
  ])
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const ssEcdh = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ecdhPublicKey },
    ephemeral.privateKey,
    256,
  )
  const { cipherText: mlkemCiphertext, sharedSecret: ssMlkem } = ml_kem768.encapsulate(mlkemPublicKey)
  return { ephPubRaw, mlkemCiphertext, ssEcdh, ssMlkem }
}

/** Seal an opaque payload into a v2 AK envelope for one recipient. */
const sealAkPayload = async (
  payload: Uint8Array,
  ecdhPublicKey: CryptoKey,
  mlkemPublicKey: Uint8Array,
): Promise<string> => {
  const { ephPubRaw, mlkemCiphertext, ssEcdh, ssMlkem } = await beginHybridSeal(ecdhPublicKey, mlkemPublicKey)
  const sealKey = await deriveHybridSealKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: aesGcmAlgorithm, iv: iv as BufferSource, additionalData: akEnvelopeAad as BufferSource },
      sealKey,
      payload as BufferSource,
    ),
  )

  const envelope = new Uint8Array(1 + ephPubRaw.length + mlkemCiphertext.length + iv.length + sealed.length)
  envelope[0] = akEnvelopeVersion
  envelope.set(ephPubRaw, 1)
  envelope.set(mlkemCiphertext, 1 + ephPubRaw.length)
  envelope.set(iv, 1 + ephPubRaw.length + mlkemCiphertext.length)
  envelope.set(sealed, 1 + ephPubRaw.length + mlkemCiphertext.length + iv.length)
  return uint8ArrayToBase64(envelope)
}

/**
 * Open a v2 AK envelope back to its payload bytes. Throws `DecryptionError` on
 * a wrong recipient, a tampered byte anywhere (the transcript feeds the key
 * derivation and the version byte is the AAD, so nothing outside the tag is
 * malleable either), or a non-v2 version byte.
 */
const openAkPayload = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<Uint8Array> => {
  const envelope = base64ToUint8Array(wrappedBase64)
  if (envelope[0] !== akEnvelopeVersion) {
    throw new DecryptionError(`Unsupported AK envelope version: ${envelope[0]}`)
  }
  if (envelope.length < minAkEnvelopeLength) {
    throw new DecryptionError(`Invalid AK envelope: ${envelope.length} bytes, need >= ${minAkEnvelopeLength}`)
  }

  let offset = 1
  const ephPubRaw = envelope.slice(offset, offset + ephemeralPubKeyLength)
  offset += ephemeralPubKeyLength
  const mlkemCiphertext = envelope.slice(offset, offset + mlkemCiphertextLength)
  offset += mlkemCiphertextLength
  const iv = envelope.slice(offset, offset + ivLength)
  offset += ivLength
  const sealed = envelope.slice(offset)

  const ephemeralPublicKey = await crypto.subtle.importKey(
    'raw',
    ephPubRaw as BufferSource,
    { name: ecdhAlgorithm, namedCurve: ecdhCurve },
    false,
    [],
  )
  const ssEcdh = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ephemeralPublicKey },
    ecdhPrivateKey,
    256,
  )
  const ssMlkem = ml_kem768.decapsulate(mlkemCiphertext, mlkemSecretKey)
  const sealKey = await deriveHybridSealKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'decrypt')
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: aesGcmAlgorithm, iv: iv as BufferSource, additionalData: akEnvelopeAad as BufferSource },
      sealKey,
      sealed as BufferSource,
    ),
  )
}

/**
 * Wrap the AK for one recipient using hybrid ECDH P-256 + ML-KEM-768, sealing
 * the account's CURRENT `primary_key_id` into the same AEAD (THU-890).
 * Envelope: [version=0x02][ephPubRaw 65B][mlkemCiphertext 1088B][iv 12B][AES-GCM(rawAK ‖ pointer)]
 *
 * The pointer travels INSIDE the tag on purpose: the envelope a device adopts
 * after a rotation is the one artifact the server cannot forge (it never holds
 * a cleartext AK), so making it the pointer's only trusted source is what stops
 * a served `primary_key_id` rollback steering new writes onto a DEK a revoked
 * device still holds. `ak` must be extractable (transiently, at mint time —
 * same rule as the old AES-KW wrap).
 */
export const wrapAK = async (
  ak: CryptoKey,
  ecdhPublicKey: CryptoKey,
  mlkemPublicKey: Uint8Array,
  primaryKeyId: KeyId,
): Promise<string> => {
  try {
    const rawAK = new Uint8Array(await crypto.subtle.exportKey('raw', ak))
    const pointerBytes = new TextEncoder().encode(primaryKeyId)
    const payload = new Uint8Array(rawAK.length + pointerBytes.length)
    payload.set(rawAK, 0)
    payload.set(pointerBytes, rawAK.length)
    try {
      return await sealAkPayload(payload, ecdhPublicKey, mlkemPublicKey)
    } finally {
      rawAK.fill(0)
      payload.fill(0)
    }
  } catch (err) {
    throw new EncryptionError('Failed to wrap account key', { cause: err })
  }
}

/**
 * Wrap a legacy CK into a v1 envelope: [version=0x01][ephPubRaw][mlkemCiphertext][AES-KW(key) 40B].
 * Production never writes these any more — the ONLY writer is the e2e harness
 * seeding a pre-migration account — but the layout must stay exact because
 * `unwrapLegacyCK` (the v1→v2 absorption) reads it.
 */
export const wrapLegacyCK = async (
  ck: CryptoKey,
  ecdhPublicKey: CryptoKey,
  mlkemPublicKey: Uint8Array,
): Promise<string> => {
  try {
    const { ephPubRaw, mlkemCiphertext, ssEcdh, ssMlkem } = await beginHybridSeal(ecdhPublicKey, mlkemPublicKey)
    const wrappingKey = await deriveHybridWrappingKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'wrapKey')
    const wrappedBytes = new Uint8Array(await crypto.subtle.wrapKey('raw', ck, wrappingKey, aesKwAlgorithm))

    const envelope = new Uint8Array(1 + ephPubRaw.length + mlkemCiphertext.length + wrappedBytes.length)
    envelope[0] = envelopeVersion
    envelope.set(ephPubRaw, 1)
    envelope.set(mlkemCiphertext, 1 + ephPubRaw.length)
    envelope.set(wrappedBytes, 1 + ephPubRaw.length + mlkemCiphertext.length)
    return uint8ArrayToBase64(envelope)
  } catch (err) {
    throw new EncryptionError('Failed to wrap legacy content key', { cause: err })
  }
}

/**
 * Rewrap a wrapped AK for a different device's public keys — the approval path.
 * Opens the sealed payload in memory and re-seals the EXACT bytes for the
 * target, so the pointer sealed by the original writer travels unchanged: an
 * approver cannot (and need not) restate it.
 */
export const rewrapAK = async (
  wrappedAKBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
  targetEcdhPublicKey: CryptoKey,
  targetMlkemPublicKey: Uint8Array,
): Promise<string> => {
  try {
    const payload = await openAkPayload(wrappedAKBase64, ecdhPrivateKey, mlkemSecretKey)
    try {
      return await sealAkPayload(payload, targetEcdhPublicKey, targetMlkemPublicKey)
    } finally {
      payload.fill(0)
    }
  } catch (err) {
    if (err instanceof EncryptionError) {
      throw err
    }
    throw new EncryptionError('Failed to rewrap account key', { cause: err })
  }
}

/** An opened AK envelope: the key plus the pointer sealed with it (THU-890). */
export type OpenedAkEnvelope = {
  ak: CryptoKey
  /** The `primary_key_id` the envelope's writer sealed in — the pointer's only trusted source. */
  primaryKeyId: KeyId
}

/**
 * Unwrap an AK envelope. Returns the non-extractable AK plus the sealed
 * `primary_key_id` — the two are covered by ONE auth tag, so a caller can trust
 * the pointer exactly as far as it trusts the AK.
 */
export const unwrapAK = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<OpenedAkEnvelope> => unwrapAKInternal(wrappedBase64, ecdhPrivateKey, mlkemSecretKey, false)

/**
 * Parse a v1 (0x01) hybrid envelope and derive the AES-KW unwrapping key from
 * the ECDH + ML-KEM transcripts. Returns the derived key and the still-wrapped
 * payload bytes. Since the AK envelope moved to the v2 AEAD layout (THU-890),
 * the ONLY remaining reader is `unwrapLegacyCK` — the v1→v2 CK absorption.
 */
const deriveEnvelopeUnwrap = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<{ unwrappingKey: CryptoKey; wrappedKeyBytes: Uint8Array }> => {
  const envelope = base64ToUint8Array(wrappedBase64)

  const version = envelope[0]
  if (version !== envelopeVersion) {
    throw new DecryptionError(`Unsupported envelope version: ${version}`)
  }
  if (envelope.length < minEnvelopeLength) {
    throw new DecryptionError(`Invalid envelope: ${envelope.length} bytes, need >= ${minEnvelopeLength}`)
  }

  let offset = 1
  const ephPubRaw = envelope.slice(offset, offset + ephemeralPubKeyLength)
  offset += ephemeralPubKeyLength
  const mlkemCiphertext = envelope.slice(offset, offset + mlkemCiphertextLength)
  offset += mlkemCiphertextLength
  const wrappedKeyBytes = envelope.slice(offset)

  const ephemeralPublicKey = await crypto.subtle.importKey(
    'raw',
    ephPubRaw,
    { name: ecdhAlgorithm, namedCurve: ecdhCurve },
    false,
    [],
  )
  const ssEcdh = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ephemeralPublicKey },
    ecdhPrivateKey,
    256,
  )
  const ssMlkem = ml_kem768.decapsulate(mlkemCiphertext, mlkemSecretKey)
  const unwrappingKey = await deriveHybridWrappingKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'unwrapKey')
  return { unwrappingKey, wrappedKeyBytes }
}

/**
 * Internal open of a v2 AK envelope with configurable extractability
 * (extractable=true exists for tests only — production always imports the AK
 * non-extractable and `rewrapAK` never materialises a CryptoKey at all).
 */
const unwrapAKInternal = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
  extractable: boolean,
): Promise<OpenedAkEnvelope> => {
  try {
    const payload = await openAkPayload(wrappedBase64, ecdhPrivateKey, mlkemSecretKey)
    try {
      if (payload.length <= rawAkLength) {
        throw new DecryptionError('AK envelope payload carries no primary key_id')
      }
      const ak = await crypto.subtle.importKey(
        'raw',
        payload.slice(0, rawAkLength) as BufferSource,
        { name: aesGcmAlgorithm, length: aesKeyLength },
        extractable,
        ['wrapKey', 'unwrapKey'],
      )
      const primaryKeyId = new TextDecoder().decode(payload.slice(rawAkLength))
      return { ak, primaryKeyId }
    } finally {
      payload.fill(0)
    }
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw err
    }
    throw new DecryptionError('Failed to unwrap account key', { cause: err })
  }
}

/**
 * WS3 — legacy CK absorption. Unwrap a v1 device envelope into the legacy
 * content key as an EXTRACTABLE AES-256-GCM key (usages encrypt/decrypt). The
 * envelope is byte-identical to a v2 AK envelope, so this shares
 * `deriveEnvelopeUnwrap`; only the wrapped payload is a CK (AES-GCM) rather than
 * an AK (AES-KW). Runs once, on the migrator, against the server-fetched
 * envelope. The result is extractable so the service layer can (a) `wrapDEK` it
 * into the keyring as the reserved `"v1"` slot and (b) feed it to
 * `recoverCanarySecretV1` for the D1 possession proof.
 */
export const unwrapLegacyCK = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<CryptoKey> => {
  try {
    const { unwrappingKey, wrappedKeyBytes } = await deriveEnvelopeUnwrap(wrappedBase64, ecdhPrivateKey, mlkemSecretKey)
    return await crypto.subtle.unwrapKey(
      'raw',
      wrappedKeyBytes as BufferSource,
      unwrappingKey,
      aesKwAlgorithm,
      { name: aesGcmAlgorithm, length: aesKeyLength },
      true,
      ['encrypt', 'decrypt'],
    )
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw err
    }
    throw new DecryptionError('Failed to unwrap legacy content key', { cause: err })
  }
}

// =============================================================================
// Org escrow (THU-804 POC): Wrap AK to the operator escrow public key
//
// Deliberately ECDH-only — no ML-KEM hybrid for this one recipient (a disclosed
// downgrade; the operator key is a plain P-256 keypair generated offline). The
// frontend only ever wraps: there is no unwrap function here, because the org
// envelope is decrypted exclusively by the offline operator tool
// (scripts/org-escrow-decrypt.ts) holding the private key.
// =============================================================================

/**
 * Import the operator org-escrow public key (base64 raw uncompressed P-256
 * point, 65 bytes) for ECDH wrapping. ECDH-only by design — decryption happens
 * only in the offline operator tool, never in the frontend.
 */
export const importOrgPublicKey = async (base64: string): Promise<CryptoKey> => {
  const raw = base64ToUint8Array(base64)
  if (raw.length !== p256RawPublicKeyLength) {
    throw new EncryptionError(`Invalid org public key: ${raw.length} bytes, expected ${p256RawPublicKeyLength}`)
  }
  try {
    return await crypto.subtle.importKey('raw', raw, { name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, [])
  } catch (err) {
    throw new EncryptionError('Failed to import org public key', { cause: err })
  }
}

/**
 * Wrap the AK to the operator escrow public key (THU-804).
 * Envelope, base64 end to end: `[orgEnvelopeVersion 1B][ephPubRaw 65B][AES-KW-wrapped AK 40B]`.
 * Derivation: ephemeral ECDH P-256 deriveBits (256) → HKDF-SHA256 with
 * `info = orgEscrowHkdfInfo`, `salt = ephPubRaw` → AES-KW-256 → wrap the raw AK.
 *
 * Same construction as the hybrid `wrapAK` minus ML-KEM — deliberately ECDH-only
 * for this one recipient. The inverse lives only in the offline operator tool.
 */
export const wrapAKForOrg = async (ak: CryptoKey, orgPublicKey: CryptoKey): Promise<string> => {
  try {
    const ephemeral = await crypto.subtle.generateKey({ name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, [
      'deriveBits',
    ])
    const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
    const ssEcdh = await crypto.subtle.deriveBits(
      { name: ecdhAlgorithm, public: orgPublicKey },
      ephemeral.privateKey,
      256,
    )

    const hkdfKey = await crypto.subtle.importKey('raw', ssEcdh, 'HKDF', false, ['deriveKey'])
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: hkdfHash, salt: ephPubRaw as BufferSource, info: orgEscrowHkdfInfoBytes },
      hkdfKey,
      { name: aesKwAlgorithm, length: aesKeyLength },
      false,
      ['wrapKey'],
    )
    const wrappedAKBytes = new Uint8Array(await crypto.subtle.wrapKey('raw', ak, wrappingKey, aesKwAlgorithm))

    const envelope = new Uint8Array(1 + ephPubRaw.length + wrappedAKBytes.length)
    envelope[0] = orgEnvelopeVersion
    envelope.set(ephPubRaw, 1)
    envelope.set(wrappedAKBytes, 1 + ephPubRaw.length)
    return uint8ArrayToBase64(envelope)
  } catch (err) {
    throw new EncryptionError('Failed to wrap account key for org escrow', { cause: err })
  }
}

// =============================================================================
// AES-GCM encrypt / decrypt
// =============================================================================

type EncryptedData = {
  iv: string // base64
  ciphertext: string // base64
}

/** Raw-bytes AES-GCM output, used for at-rest encryption in IndexedDB. */
export type EncryptedBytes = {
  iv: Uint8Array
  ciphertext: Uint8Array
}

/**
 * Encrypt plaintext with a DEK using AES-256-GCM. Returns base64-encoded IV and
 * ciphertext. `additionalData` (AAD) is authenticated but not encrypted —
 * decryption fails unless the exact same bytes are supplied. v1 values were
 * written with AAD absent, so the dual-read v1 branch omits it.
 */
export const encrypt = async (
  plaintext: string,
  dek: CryptoKey,
  additionalData?: Uint8Array,
): Promise<EncryptedData> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const encoded = new TextEncoder().encode(plaintext)
    const ciphertext = await crypto.subtle.encrypt(
      { name: aesGcmAlgorithm, iv, ...(additionalData && { additionalData: additionalData as BufferSource }) },
      dek,
      encoded,
    )
    return {
      iv: uint8ArrayToBase64(iv),
      ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    }
  } catch (err) {
    throw new EncryptionError('Failed to encrypt data', { cause: err })
  }
}

/** Decrypt ciphertext with a DEK using AES-256-GCM. AAD must match the encrypt call. */
export const decrypt = async (data: EncryptedData, dek: CryptoKey, additionalData?: Uint8Array): Promise<string> => {
  try {
    const iv = base64ToUint8Array(data.iv)
    const ciphertext = base64ToUint8Array(data.ciphertext)
    const decrypted = await crypto.subtle.decrypt(
      { name: aesGcmAlgorithm, iv, ...(additionalData && { additionalData: additionalData as BufferSource }) },
      dek,
      ciphertext,
    )
    return new TextDecoder().decode(decrypted)
  } catch (err) {
    throw new DecryptionError('Failed to decrypt data', { cause: err })
  }
}

/** Encrypt raw bytes with AES-256-GCM (at-rest encryption of the ML-KEM secret key). */
export const encryptBytes = async (data: Uint8Array, key: CryptoKey): Promise<EncryptedBytes> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const ciphertext = await crypto.subtle.encrypt({ name: aesGcmAlgorithm, iv }, key, data as BufferSource)
    return { iv, ciphertext: new Uint8Array(ciphertext) }
  } catch (err) {
    throw new EncryptionError('Failed to encrypt bytes', { cause: err })
  }
}

/** Decrypt raw bytes encrypted by `encryptBytes`. */
export const decryptBytes = async (data: EncryptedBytes, key: CryptoKey): Promise<Uint8Array> => {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: aesGcmAlgorithm, iv: data.iv as BufferSource },
      key,
      data.ciphertext as BufferSource,
    )
    return new Uint8Array(decrypted)
  } catch (err) {
    throw new DecryptionError('Failed to decrypt bytes', { cause: err })
  }
}

// =============================================================================
// Base64 helpers
// =============================================================================

/** Encode bytes as base64 (binary-safe, no Buffer dependency). */
export const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode a base64 string into bytes. */
export const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Array.from(atob(base64), (c) => c.charCodeAt(0)))
