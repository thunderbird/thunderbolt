/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { createHandleError } from '@/lib/error-utils'
import { HttpError } from '@/lib/http'
import { trackError } from '@/lib/posthog'
import {
  generateKeyPair,
  generateMlKemKeyPair,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  wrapAK,
  rewrapAK,
  unwrapAK,
  wrapDEK,
  unwrapDEK,
  mintDEK,
  createCanary,
  verifyCanary,
  deriveSigningKeyPair,
  signChallenge,
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  deriveAKFromSeed,
  generateKdfSalt,
  storeKeyPair,
  getKeyPair,
  storeAK,
  getAK,
  storeWrappedDEK,
  getWrappedDEK,
  stageWrappedDEKs,
  storePrimaryKeyId,
  storeKeyVersion,
  clearAllKeys,
  ValidationError,
  type StoredKeyPair,
} from '@/crypto'
import { getDeviceId } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'
import {
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  fetchEncryptionMetadata,
  fetchWrappedKeys,
  fetchWrappedKey,
  postWrappedKey,
  fetchChallenge,
  postRotate,
  denyDevice as denyDeviceApi,
  revokeDevice as revokeDeviceApi,
  setDeviceNodeId as setDeviceNodeIdApi,
  type RegisterDeviceResponse,
} from '@/api/encryption'
import { getAllDevices } from '@/dal'
import { getDb } from '@/db/database'
import { invalidateKeyCache, resetCodecState } from '@/db/encryption'
import {
  initialKeyId,
  type ChallengeOperation,
  type ChallengeProof,
  type KeyId,
  type WrappedKeyEntry,
} from '@shared/e2ee-types'

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when POST /encryption/rotate rejects the payload (4xx) — the local
 * view of the keyring/devices/signing key was stale. Local state has already
 * been refreshed (`refreshAK`); the caller should simply retry the rotation.
 */
export class RotationStaleError extends Error {
  constructor(options?: ErrorOptions) {
    super('Key rotation state was stale — state refreshed, retry the rotation', options)
    this.name = 'RotationStaleError'
  }
}

// =============================================================================
// Shared helpers
// =============================================================================

/** Get existing key pairs from IndexedDB or generate and store new ones. */
const getOrCreateKeyPair = async (): Promise<StoredKeyPair> => {
  const existing = await getKeyPair()
  if (existing) {
    return existing
  }

  const ecdhKeyPair = await generateKeyPair()
  const mlkemKeyPair = generateMlKemKeyPair()
  await storeKeyPair(ecdhKeyPair.privateKey, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey, mlkemKeyPair.secretKey)
  return {
    ecdhPrivateKey: ecdhKeyPair.privateKey,
    ecdhPublicKey: ecdhKeyPair.publicKey,
    mlkemPublicKey: mlkemKeyPair.publicKey,
    mlkemSecretKey: mlkemKeyPair.secretKey,
  }
}

/**
 * Recover the canary secret from local key material: metadata → AK → wrapped
 * DEK '0' → unwrap → decrypt canary. The secret seeds the deterministic ECDSA
 * signing keypair used for challenge proofs — it never leaves the client.
 */
const getCanarySecret = async (httpClient: HttpClient): Promise<string> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  const ak = await getAK()
  if (!ak) {
    throw new Error('Account key not found in IndexedDB')
  }
  const wrappedDEK = await getWrappedDEK(initialKeyId)
  if (!wrappedDEK) {
    throw new Error(`Wrapped DEK '${initialKeyId}' not found in IndexedDB`)
  }
  const dek0 = await unwrapDEK(wrappedDEK, ak)
  const { valid, canarySecret } = await verifyCanary(dek0, metadata.canary_iv, metadata.canary_ctext)
  if (!valid || !canarySecret) {
    throw new Error('Failed to verify canary — key material may be corrupted')
  }
  return canarySecret
}

/**
 * Build a ChallengeProof for a trust-sensitive operation: fetch a single-use
 * nonce and sign `nonce ‖ operation ‖ deviceId` with the signing key derived
 * from the canary secret. Pass `canarySecret` when it is already in hand
 * (recovery); otherwise it is extracted from local key material.
 */
const buildProof = async (
  httpClient: HttpClient,
  operation: ChallengeOperation,
  canarySecret?: string,
): Promise<ChallengeProof> => {
  const secret = canarySecret ?? (await getCanarySecret(httpClient))
  const { nonce } = await fetchChallenge(httpClient, operation)
  const deviceId = getDeviceId()
  const signature = await signChallenge(secret, nonce, operation, deviceId)
  return { signature, nonce, operation, deviceId }
}

// =============================================================================
// Detecting step — register device and store key pair
// =============================================================================

/**
 * Register this device with the server and store the key pair.
 * Idempotent: reuses existing key pair from IndexedDB if present.
 * Returns the registration response so the caller can determine first vs additional device.
 */
export const registerThisDevice = async (httpClient: HttpClient): Promise<RegisterDeviceResponse> => {
  const keyPair = await getOrCreateKeyPair()

  const publicKeyBase64 = await exportPublicKey(keyPair.ecdhPublicKey)
  const mlkemPublicKeyBase64 = exportMlKemPublicKey(keyPair.mlkemPublicKey)
  const deviceId = getDeviceId()

  return registerDevice(httpClient, {
    deviceId,
    publicKey: publicKeyBase64,
    mlkemPublicKey: mlkemPublicKeyBase64,
    name: getDeviceDisplayName(),
  })
}

// =============================================================================
// Keyring staging + AK refresh (consumed by D2's key-request responder)
// =============================================================================

/**
 * Stage the full server-side keyring into IndexedDB for the SharedWorker:
 * fetch every wrapped DEK, refresh the primary key_id from metadata, and
 * invalidate the codec caches so encoders pick up the new state.
 */
export const stageKeyring = async (httpClient: HttpClient): Promise<void> => {
  const { keys } = await fetchWrappedKeys(httpClient)
  await stageWrappedDEKs(keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key })))
  const metadata = await fetchEncryptionMetadata(httpClient)
  await storePrimaryKeyId(metadata.primary_key_id)
  await storeKeyVersion(metadata.key_version)
  invalidateKeyCache()
}

/**
 * Refresh this device's AK after a rotation (key_version bump or DEK-unwrap
 * failure): re-fetch the replaced envelope, unwrap the new AK, store it, then
 * re-stage the keyring. Without this, no remaining device can read
 * post-revocation data (plan §3).
 */
export const refreshAK = async (httpClient: HttpClient): Promise<void> => {
  const { wrappedCK } = await fetchMyEnvelope(httpClient)
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found in IndexedDB')
  }
  const ak = await unwrapAK(wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey)
  await storeAK(ak)
  await stageKeyring(httpClient)
}

// =============================================================================
// Flow C — First device setup
// =============================================================================

/**
 * Complete first device setup: derive the AK from a fresh recovery seed, mint
 * DEK '0', create the canary + signing keypair, and store everything on the
 * server in one atomic bootstrap envelope. Returns the 24-word recovery key.
 * Must be called after `registerThisDevice` (key pair already in IndexedDB).
 */
export const completeFirstDeviceSetup = async (httpClient: HttpClient): Promise<string> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found — call registerThisDevice first')
  }

  const seed = generateRecoverySeed()
  const recoveryKey = encodeRecoverySeed(seed)
  const kdfSalt = generateKdfSalt()
  // Extractable only transiently — it must be wrapped into the device envelope.
  const extractableAK = await deriveAKFromSeed(seed, kdfSalt, { extractable: true })

  const { dek, wrappedKey } = await mintDEK(extractableAK)
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  const wrappedCK = await wrapAK(extractableAK, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey)
  const ak = await reimportAsNonExtractable(extractableAK)

  await storeEnvelope(httpClient, {
    deviceId: getDeviceId(),
    wrappedCK,
    canaryIv,
    canaryCtext,
    signingPublicKey: publicKeySpki,
    kdfSalt,
    wrappedKeys: [{ keyId: initialKeyId, wrappedKey }],
  })

  await storeAK(ak)
  await storeWrappedDEK(initialKeyId, wrappedKey)
  await storePrimaryKeyId(initialKeyId)
  await storeKeyVersion(1)
  invalidateKeyCache()

  return recoveryKey
}

// =============================================================================
// Flow D (trusted device) — Approve / deny / revoke / node-id
// =============================================================================

/**
 * Approve a pending device by rewrapping the AK with its public keys and storing the envelope.
 * Fetches this device's own envelope from the server and rewraps — the locally stored
 * non-extractable AK is never touched, preserving its security properties.
 * Gated by an 'approve' challenge proof (replaces the v1 canary-secret body).
 */
export const approveDevice = async (
  httpClient: HttpClient,
  pendingDeviceId: string,
  pendingEcdhPublicKeyBase64: string,
  pendingMlkemPublicKeyBase64: string,
): Promise<void> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found in IndexedDB')
  }

  const [{ wrappedCK: myWrappedCK }, proof] = await Promise.all([
    fetchMyEnvelope(httpClient),
    buildProof(httpClient, 'approve'),
  ])
  const pendingEcdhPub = await importPublicKey(pendingEcdhPublicKeyBase64)
  const pendingMlkemPub = importMlKemPublicKey(pendingMlkemPublicKeyBase64)
  const wrappedCK = await rewrapAK(
    myWrappedCK,
    keyPair.ecdhPrivateKey,
    keyPair.mlkemSecretKey,
    pendingEcdhPub,
    pendingMlkemPub,
  )

  await storeEnvelope(httpClient, { deviceId: pendingDeviceId, wrappedCK, proof })
}

/** Deny a pending device, gated by a 'deny' challenge proof. */
export const denyDeviceWithProof = async (httpClient: HttpClient, deviceId: string): Promise<void> => {
  const proof = await buildProof(httpClient, 'deny')
  await denyDeviceApi(httpClient, deviceId, proof)
}

/**
 * Bind a device to an iroh P2P endpoint identity (node_id), gated by a
 * 'node-id' challenge proof; the node_id then syncs down via PowerSync.
 */
export const setDeviceNodeIdWithProof = async (
  httpClient: HttpClient,
  deviceId: string,
  nodeId: string,
): Promise<void> => {
  const proof = await buildProof(httpClient, 'node-id')
  await setDeviceNodeIdApi(httpClient, deviceId, nodeId, proof)
}

/**
 * Build the revoke proof, honoring the pre-E2EE fallback: no encryption
 * metadata (404) or a v1 leftover (NULL signing_public_key) → no proof needed
 * (the backend skips verification for those accounts).
 */
const buildRevokeProof = async (httpClient: HttpClient): Promise<ChallengeProof | undefined> => {
  const metadata = await fetchEncryptionMetadata(httpClient).catch((err: unknown) => {
    if (err instanceof HttpError && err.response.status === 404) {
      return null
    }
    throw err
  })
  if (!metadata || metadata.signing_public_key == null) {
    return undefined
  }
  return buildProof(httpClient, 'revoke')
}

/**
 * Revoke a device with a 'revoke' challenge proof when E2EE v2 is active.
 * Falls back to no proof for pre-E2EE users and v1 leftovers. Note: this only
 * cuts server access — `revokeDeviceAndRotate` also locks the device out of
 * the keyring cryptographically.
 */
export const revokeDeviceWithProof = async (httpClient: HttpClient, deviceId: string): Promise<void> => {
  const proof = await buildRevokeProof(httpClient).catch((err: unknown) => {
    trackError(
      createHandleError('CANARY_EXTRACTION_FAILED', 'Failed to build challenge proof during device revocation', err),
    )
    throw err
  })
  await revokeDeviceApi(httpClient, deviceId, proof)
}

// =============================================================================
// Flow D (new device) — Check approval and unwrap AK
// =============================================================================

/**
 * Check if this device has been approved (envelope exists) and unwrap the AK.
 * On success also stages the full DEK keyring + primary key_id for the worker.
 * Returns true if the AK was unwrapped and stored, false if not yet approved.
 */
export const checkApprovalAndUnwrap = async (httpClient: HttpClient): Promise<boolean> => {
  try {
    const { wrappedCK } = await fetchMyEnvelope(httpClient)
    const keyPair = await getKeyPair()
    if (!keyPair) {
      throw new Error('Key pair not found in IndexedDB')
    }

    const ak = await unwrapAK(wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey)
    await storeAK(ak)
    await stageKeyring(httpClient)
    return true
  } catch (err) {
    // 404 = not yet approved, return false so caller can retry
    if (err instanceof HttpError && err.response.status === 404) {
      return false
    }
    // Re-throw transient/unexpected errors so they surface properly
    throw err
  }
}

// =============================================================================
// Flow E — Recover with recovery key
// =============================================================================

/**
 * Recover encryption access using the 24-word recovery key: re-derive the AK
 * (seed + server kdf_salt), verify it against the canary via DEK '0', then
 * self-approve this device with a challenge proof (pending devices may fetch
 * wrapped keys and challenges — the signature is the gate).
 */
export const recoverWithKey = async (httpClient: HttpClient, recoveryPhrase: string): Promise<void> => {
  const seed = decodeRecoveryKey(recoveryPhrase)

  const metadata = await fetchEncryptionMetadata(httpClient)
  if (metadata.signing_public_key == null || metadata.kdf_salt == null) {
    // v1 account — its recovery key encoded the raw CK, not a seed, and its
    // proof mechanism no longer exists. The only way forward is a fresh setup.
    throw new ValidationError(
      'This account uses an outdated encryption setup. Please reset encryption and set it up again.',
    )
  }

  // Extractable only transiently — it must be wrapped into this device's envelope.
  const extractableAK = await deriveAKFromSeed(seed, metadata.kdf_salt, { extractable: true })

  // Register first: the keys/challenge endpoints require a registered
  // (pending is fine) caller device.
  const keyPair = await getOrCreateKeyPair()
  const publicKeyBase64 = await exportPublicKey(keyPair.ecdhPublicKey)
  const mlkemPublicKeyBase64 = exportMlKemPublicKey(keyPair.mlkemPublicKey)
  const deviceId = getDeviceId()

  await registerDevice(httpClient, {
    deviceId,
    publicKey: publicKeyBase64,
    mlkemPublicKey: mlkemPublicKeyBase64,
    name: getDeviceDisplayName(),
  })

  // Verify the phrase: unwrap DEK '0' with the derived AK and decrypt the
  // canary. A wrong seed fails the AES-KW integrity check or the canary.
  const { wrapped_key: wrappedDEK0 } = await fetchWrappedKey(httpClient, initialKeyId)
  const dek0 = await unwrapDEK(wrappedDEK0, extractableAK).catch(() => null)
  if (!dek0) {
    throw new ValidationError('Invalid recovery key')
  }
  const { valid, canarySecret } = await verifyCanary(dek0, metadata.canary_iv, metadata.canary_ctext)
  if (!valid || !canarySecret) {
    throw new ValidationError('Invalid recovery key')
  }

  // Self-approve: wrap the AK for our own keys and prove key possession.
  const wrappedCK = await wrapAK(extractableAK, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey)
  const proof = await buildProof(httpClient, 'approve', canarySecret)
  await storeEnvelope(httpClient, { deviceId, wrappedCK, proof })

  const ak = await reimportAsNonExtractable(extractableAK)
  await storeAK(ak)
  await stageKeyring(httpClient)
}

// =============================================================================
// Flow F — Rotations (THU-434)
// =============================================================================

/** Public keys of one trusted device, as read from the synced `devices` table. */
export type TrustedDevicePublicKeys = {
  id: string
  publicKey: string
  mlkemPublicKey: string
}

/**
 * Read the trusted, non-revoked devices (with their envelope public keys) from
 * the local synced `devices` table. Devices without public keys (e.g. bridge
 * devices) cannot hold an AK envelope and are skipped.
 */
const listTrustedDeviceKeys = async (): Promise<TrustedDevicePublicKeys[]> => {
  const devices = await getAllDevices(getDb())
  return devices.flatMap((device) =>
    device.trusted === 1 && device.revokedAt == null && device.publicKey && device.mlkemPublicKey
      ? [{ id: device.id, publicKey: device.publicKey, mlkemPublicKey: device.mlkemPublicKey }]
      : [],
  )
}

export type RotateAKOptions = {
  /**
   * Devices that must NOT receive a new-AK envelope even if the synced
   * `devices` table still shows them trusted (sync lag after a revocation).
   */
  excludeDeviceIds?: string[]
  /** Dependency seam for the synced-devices read (tests). */
  listTrustedDevices?: () => Promise<TrustedDevicePublicKeys[]>
}

/**
 * Rotate the Account Key (0 rows re-encrypted): derive a new AK from a fresh
 * recovery seed, re-wrap EVERY DEK on the live keyring under it, re-issue an
 * envelope for every live trusted device, and replace the canary + signing
 * keypair — submitted atomically via POST /encryption/rotate.
 *
 * Returns the NEW 24-word recovery key — the UI must show it (the old one is
 * now useless). On a 4xx (stale local state, e.g. a concurrent rotation) the
 * local AK/keyring are refreshed and a retryable `RotationStaleError` is thrown.
 */
export const rotateAK = async (httpClient: HttpClient, opts: RotateAKOptions = {}): Promise<string> => {
  // Proof FIRST — it must be signed with the OLD signing key, which the server
  // still holds until the rotate transaction commits.
  const proof = await buildProof(httpClient, 'rotate')

  const oldAK = await getAK()
  if (!oldAK) {
    throw new Error('Account key not found in IndexedDB')
  }

  const newSeed = generateRecoverySeed()
  const recoveryKey = encodeRecoverySeed(newSeed)
  const newKdfSalt = generateKdfSalt()
  const newAK = await deriveAKFromSeed(newSeed, newKdfSalt, { extractable: true })

  // Re-wrap the FULL live keyring — re-wrapping only a subset would strand the
  // missing key_ids under the discarded old AK (permanent data loss).
  const { keys } = await fetchWrappedKeys(httpClient)
  const wrappedKeys: WrappedKeyEntry[] = []
  const deks = new Map<KeyId, CryptoKey>()
  for (const key of keys) {
    const dek = await unwrapDEK(key.wrapped_key, oldAK, true)
    deks.set(key.key_id, dek)
    wrappedKeys.push({ keyId: key.key_id, wrappedKey: await wrapDEK(dek, newAK) })
  }
  const dek0 = deks.get(initialKeyId)
  if (!dek0) {
    throw new Error(`Keyring is missing key_id '${initialKeyId}' — cannot rotate`)
  }

  // New-AK envelope for every live trusted device, minus explicit exclusions
  // (a just-revoked device may still look trusted through sync lag).
  const excluded = new Set(opts.excludeDeviceIds ?? [])
  const trustedDevices = await (opts.listTrustedDevices ?? listTrustedDeviceKeys)()
  const envelopes: Array<{ deviceId: string; wrappedCK: string }> = []
  for (const device of trustedDevices) {
    if (excluded.has(device.id)) {
      continue
    }
    const ecdhPub = await importPublicKey(device.publicKey)
    const mlkemPub = importMlKemPublicKey(device.mlkemPublicKey)
    envelopes.push({ deviceId: device.id, wrappedCK: await wrapAK(newAK, ecdhPub, mlkemPub) })
  }

  // New canary under DEK '0' (the DEK itself did not change) + new signing keypair.
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek0)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  try {
    await postRotate(httpClient, {
      proof,
      envelopes,
      wrappedKeys,
      canaryIv,
      canaryCtext,
      signingPublicKey: publicKeySpki,
      kdfSalt: newKdfSalt,
    })
  } catch (err) {
    if (err instanceof HttpError && err.response.status >= 400 && err.response.status < 500) {
      // Stale local state (concurrent rotation / device change) — re-fetch our
      // envelope + keyring so the caller can rebuild and retry.
      await refreshAK(httpClient)
      throw new RotationStaleError({ cause: err })
    }
    throw err
  }

  await storeAK(await reimportAsNonExtractable(newAK))
  await stageWrappedDEKs(wrappedKeys)
  invalidateKeyCache()

  return recoveryKey
}

/**
 * Rotate the primary DEK (forward secrecy over future writes): mint a new DEK
 * at the next numeric key_id, wrapped under the current AK, and mark it
 * primary. Old DEKs are retained forever so existing values still decrypt.
 * Returns the new key_id.
 */
export const rotateDEK = async (httpClient: HttpClient): Promise<KeyId> => {
  const ak = await getAK()
  if (!ak) {
    throw new Error('Account key not found in IndexedDB')
  }

  const { keys } = await fetchWrappedKeys(httpClient)
  const numericIds = keys.map((key) => Number.parseInt(key.key_id, 10)).filter((id) => Number.isInteger(id) && id >= 0)
  const nextKeyId: KeyId = String(numericIds.length > 0 ? Math.max(...numericIds) + 1 : 0)

  const { wrappedKey } = await mintDEK(ak)
  await postWrappedKey(httpClient, { keyId: nextKeyId, wrappedKey, setPrimary: true })

  await storeWrappedDEK(nextKeyId, wrappedKey)
  await storePrimaryKeyId(nextKeyId)
  invalidateKeyCache()

  return nextKeyId
}

/**
 * Device revocation double-rotation (THU-430): cut server access, then rotate
 * the AK (locking the revoked device out of the keyring — its envelope is
 * gone and never re-issued) and the DEK (future writes use a key_id it never
 * held). Returns the NEW 24-word recovery key — the UI must show it.
 *
 * Remaining devices self-heal: their next decode of post-rotation data hits a
 * DEK that won't unwrap under their old AK, which triggers D2's
 * `refreshAK` + re-staging path.
 */
export const revokeDeviceAndRotate = async (
  httpClient: HttpClient,
  deviceId: string,
  opts: Pick<RotateAKOptions, 'listTrustedDevices'> = {},
): Promise<string> => {
  await revokeDeviceWithProof(httpClient, deviceId)
  const recoveryKey = await rotateAK(httpClient, { ...opts, excludeDeviceIds: [deviceId] })
  await rotateDEK(httpClient)
  return recoveryKey
}

// =============================================================================
// Flow G — Full wipe (clear all keys)
// =============================================================================

export const handleFullWipe = async (): Promise<void> => {
  await clearAllKeys()
  resetCodecState()
}
