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
  rewrapKeyring,
  unwrapLegacyCK,
  wrapAKForOrg,
  createCanary,
  verifyCanary,
  recoverCanarySecretV1,
  deriveSigningKeyPair,
  signChallenge,
  decrypt,
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  deriveAKFromSeed,
  generateKdfSalt,
  storeKeyPair,
  getKeyPair,
  storeAK,
  getAK,
  storeDEK,
  getDEK,
  stageWrappedDEKs,
  storePrimaryKeyId,
  storeKeyVersion,
  clearAllKeys,
  EncryptionError,
  ValidationError,
  type StoredKeyPair,
} from '@/crypto'
import { getDeviceId } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'
import { getCachedSession } from '@/lib/session-cache'
import {
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  fetchEncryptionMetadata,
  fetchOrgPublicKey,
  fetchWrappedKeys,
  fetchWrappedKey,
  postWrappedKey,
  fetchChallenge,
  postRotate,
  postUpgrade,
  denyDevice as denyDeviceApi,
  revokeDevice as revokeDeviceApi,
  setDeviceNodeId as setDeviceNodeIdApi,
  type RegisterDeviceResponse,
} from '@/api/encryption'
import { getAllDevices } from '@/dal'
import { getDb } from '@/db/database'
import { encPrefix, encV2Prefix, invalidateKeyringCache, resetCodecState } from '@/db/encryption'
import { encryptedColumnsMap } from '@/db/encryption'
import { sql } from 'drizzle-orm'
import {
  initialKeyId,
  legacyKeyId,
  type ChallengeOperation,
  type ChallengeProof,
  type KeyId,
  type OrgPublicKeyResponse,
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

/**
 * The authenticated user's account id — the `rowId` bound into the canary AAD
 * (`canaryAAD(userId, keyId)`, Track 0). Read from the cached Better Auth
 * session (same localStorage identity source the bearer token uses offline).
 * The canary is written and verified on every device, so this MUST equal the
 * backend's `sessionUser.id`; it fails loud if unavailable.
 */
const getUserId = (): string => {
  const userId = getCachedSession()?.user?.id
  if (!userId) {
    throw new Error('User id not available — cannot bind canary AAD')
  }
  return userId
}

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

/** Resolve the wrapped DEK '0' blob — local staged copy first, then the server. */
const getWrappedDek0 = async (httpClient: HttpClient): Promise<string> => {
  const local = await getDEK(initialKeyId)
  if (local) {
    return local
  }
  const { wrapped_key: wrappedKey } = await fetchWrappedKey(httpClient, initialKeyId)
  return wrappedKey
}

/**
 * Recover the canary secret from local key material: AK → wrapped DEK '0' →
 * unwrap → decrypt the canary bound to `canaryAAD(userId, '0')`. The canary is
 * permanently anchored to DEK '0' (every server write path — bootstrap, rotate,
 * upgrade — encrypts it under key_id '0'), so verification always uses '0' even
 * after a DEK rotation moves the primary elsewhere. The secret seeds the
 * deterministic ECDSA signing keypair used for challenge proofs; it never leaves
 * the client.
 */
const getCanarySecret = async (httpClient: HttpClient): Promise<string> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  if (!metadata.canary_iv || !metadata.canary_ctext) {
    throw new Error('Canary is not set up on the server')
  }
  const ak = await getAK()
  if (!ak) {
    throw new Error('Account key not found in IndexedDB')
  }
  const dek0 = await unwrapDEK(await getWrappedDek0(httpClient), ak)
  const { valid, canarySecret } = await verifyCanary(
    dek0,
    getUserId(),
    initialKeyId,
    metadata.canary_iv,
    metadata.canary_ctext,
  )
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

/**
 * Build the org KMS escrow envelope for `ak` (POC), or `undefined` when the
 * deployment has escrow off.
 *
 * The server's answer is the only authority here. A cached `/config` flag would
 * be faster, but it is definitionally absent on a first run and stale right
 * after an operator enables escrow — and a client that guesses "off" while the
 * server requires an envelope gets its setup, rotation and migration rejected.
 * One request on three rare operations is the cheaper side of that trade.
 */
const buildOrgEnvelope = async (
  ak: CryptoKey,
  httpClient: HttpClient,
  prefetched?: OrgPublicKeyResponse,
): Promise<string | undefined> => {
  const orgKey = prefetched ?? (await fetchOrgPublicKey(httpClient))
  if (!orgKey.enabled) {
    return undefined
  }
  if (!orgKey.publicKey) {
    // Escrow is on but the operator's key is missing — the server will reject
    // whatever we send next, so say so here while we still know why.
    throw new EncryptionError('Org KMS escrow is enabled but the server returned no public key')
  }
  const orgPublicKey = await importPublicKey(orgKey.publicKey)
  return wrapAKForOrg(ak, orgPublicKey)
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
// Keyring staging + AK refresh (consumed by the key-request responder, Track C)
// =============================================================================

/**
 * Stage the full server-side keyring into IndexedDB for the SharedWorker: fetch
 * every wrapped DEK (including the `"v1"` slot), refresh the primary key_id +
 * key_version from metadata, and invalidate the codec caches so encoders pick
 * up the new state.
 *
 * Track F wires the responder's zero-arg `stageKeyring: () => Promise<void>`
 * with `() => stageKeyring(client)`.
 */
export const stageKeyring = async (httpClient: HttpClient): Promise<void> => {
  const { keys } = await fetchWrappedKeys(httpClient)
  await stageWrappedDEKs(keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key })))
  const metadata = await fetchEncryptionMetadata(httpClient)
  await storePrimaryKeyId(metadata.primary_key_id)
  await storeKeyVersion(metadata.key_version)
  invalidateKeyringCache()
}

/**
 * Refresh this device's AK after a rotation (key_version bump or DEK-unwrap
 * failure): re-fetch the replaced envelope, unwrap the new AK, store it, then
 * re-stage the keyring. Without this, no remaining device can read
 * post-revocation data.
 *
 * Track F wires the responder's zero-arg `refreshAK: () => Promise<void>` with
 * `() => refreshAK(client)`.
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
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek, getUserId(), initialKeyId)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  const wrappedCK = await wrapAK(extractableAK, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey)
  const orgEnvelope = await buildOrgEnvelope(extractableAK, httpClient)
  const ak = await reimportAsNonExtractable(extractableAK)

  await storeEnvelope(httpClient, {
    deviceId: getDeviceId(),
    wrappedCK,
    canaryIv,
    canaryCtext,
    signingPublicKey: publicKeySpki,
    kdfSalt,
    wrappedKeys: [{ keyId: initialKeyId, wrappedKey }],
    orgEnvelope,
  })

  // AK stored LAST so its presence always implies a complete local keyring.
  await storeDEK(initialKeyId, wrappedKey)
  await storePrimaryKeyId(initialKeyId)
  await storeKeyVersion(1)
  await storeAK(ak)
  invalidateKeyringCache()

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
 * Bind a device to an iroh P2P endpoint identity (node_id), gated by an
 * 'approve' challenge proof (challengeOperations has no dedicated 'node-id'
 * op — attesting a device is a trusted-device admin action); the node_id then
 * syncs down via PowerSync.
 */
export const setDeviceNodeIdWithProof = async (
  httpClient: HttpClient,
  deviceId: string,
  nodeId: string,
): Promise<void> => {
  const proof = await buildProof(httpClient, 'approve')
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
  if (
    metadata.signing_public_key == null ||
    metadata.kdf_salt == null ||
    !metadata.canary_iv ||
    !metadata.canary_ctext
  ) {
    // v1 account — its recovery key encoded the raw CK, not a seed, and its
    // proof mechanism no longer exists. A v1 account must migrate (via a
    // CK-holding device) before recovery-key entry works.
    throw new ValidationError(
      'This account has not finished upgrading its encryption. Open it on a device that already has access first.',
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
  const { valid, canarySecret } = await verifyCanary(
    dek0,
    getUserId(),
    initialKeyId,
    metadata.canary_iv,
    metadata.canary_ctext,
  )
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
// Flow F — Rotations
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

/** Wrap `ak` into a device-envelope for each trusted device, honoring exclusions. */
const buildDeviceEnvelopes = async (
  ak: CryptoKey,
  trustedDevices: TrustedDevicePublicKeys[],
  excludeDeviceIds: string[] = [],
): Promise<Array<{ deviceId: string; wrappedCK: string }>> => {
  const excluded = new Set(excludeDeviceIds)
  const envelopes: Array<{ deviceId: string; wrappedCK: string }> = []
  for (const device of trustedDevices) {
    if (excluded.has(device.id)) {
      continue
    }
    const ecdhPub = await importPublicKey(device.publicKey)
    const mlkemPub = importMlKemPublicKey(device.mlkemPublicKey)
    envelopes.push({ deviceId: device.id, wrappedCK: await wrapAK(ak, ecdhPub, mlkemPub) })
  }
  return envelopes
}

export type RotateAKOptions = {
  /**
   * Devices that must NOT receive a new-AK envelope even if the synced
   * `devices` table still shows them trusted (sync lag after a revocation).
   */
  excludeDeviceIds?: string[]
  /** Dependency seam for the synced-devices read (tests). */
  listTrustedDevices?: () => Promise<TrustedDevicePublicKeys[]>
  /**
   * Org escrow key fetched by the caller beforehand. `revokeDeviceAndRotate`
   * uses it to move this hop to BEFORE the revoke commits, so a failure fetching
   * it can't leave a device cut off with its old AK still valid. It hits our own
   * backend, not a KMS — and it removes one of several post-revoke hops, not all
   * of them, so it narrows the window rather than closing it.
   */
  orgKey?: OrgPublicKeyResponse
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

  // Re-wrap the FULL live keyring under the new AK — re-wrapping only a subset
  // would strand the missing key_ids (esp. the `"v1"` slot) under the discarded
  // old AK (permanent data loss).
  const { keys } = await fetchWrappedKeys(httpClient)
  const wrappedKeys: WrappedKeyEntry[] = await rewrapKeyring(
    keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key })),
    oldAK,
    newAK,
  )
  const dek0Wrapped = wrappedKeys.find((entry) => entry.keyId === initialKeyId)?.wrappedKey
  if (!dek0Wrapped) {
    throw new Error(`Keyring is missing key_id '${initialKeyId}' — cannot rotate`)
  }
  const dek0 = await unwrapDEK(dek0Wrapped, newAK)

  // New-AK envelope for every live trusted device, minus explicit exclusions
  // (a just-revoked device may still look trusted through sync lag).
  const trustedDevices = await (opts.listTrustedDevices ?? listTrustedDeviceKeys)()
  const envelopes = await buildDeviceEnvelopes(newAK, trustedDevices, opts.excludeDeviceIds)

  // New canary under DEK '0' (the DEK itself did not change) + new signing keypair.
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek0, getUserId(), initialKeyId)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)
  const orgEnvelope = await buildOrgEnvelope(newAK, httpClient, opts.orgKey)

  try {
    await postRotate(httpClient, {
      proof,
      envelopes,
      wrappedKeys,
      canaryIv,
      canaryCtext,
      signingPublicKey: publicKeySpki,
      kdfSalt: newKdfSalt,
      orgEnvelope,
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
  invalidateKeyringCache()

  return recoveryKey
}

/**
 * Rotate the primary DEK (forward secrecy over future writes): mint a new DEK
 * at the next numeric key_id, wrapped under the current AK, and mark it
 * primary. Old DEKs are retained forever so existing values still decrypt.
 * Returns the new key_id.
 *
 * A DEK rotation does NOT bump `key_version`, so the local codec would keep its
 * stale primary pointer — `resetCodecState()` forces this device to pick up the
 * new primary immediately. The canary stays anchored to DEK '0' (the retained
 * initial DEK), so challenge proofs keep working without a canary re-write.
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
  const proof = await buildProof(httpClient, 'rotate')
  await postWrappedKey(httpClient, { keyId: nextKeyId, wrappedKey, setPrimary: true, proof })

  await storeDEK(nextKeyId, wrappedKey)
  await storePrimaryKeyId(nextKeyId)
  resetCodecState()

  return nextKeyId
}

/**
 * Device revocation double-rotation: cut server access, then rotate the AK
 * (locking the revoked device out of the keyring — its envelope is gone and
 * never re-issued) and the DEK (future writes use a key_id it never held).
 * Returns the NEW 24-word recovery key — the UI must show it.
 *
 * Remaining devices self-heal: their next decode of post-rotation data hits a
 * DEK that won't unwrap under their old AK, which triggers the responder's
 * `refreshAK` + re-staging path.
 */
export const revokeDeviceAndRotate = async (
  httpClient: HttpClient,
  deviceId: string,
  opts: Pick<RotateAKOptions, 'listTrustedDevices'> = {},
): Promise<string> => {
  // Fetched BEFORE the revoke: the rotation that follows must not be able to
  // fail on a network hop, or we would leave the device cut off from sync while
  // the AK it still holds was never rotated — the half that actually locks it out.
  const orgKey = await fetchOrgPublicKey(httpClient)

  await revokeDeviceWithProof(httpClient, deviceId)
  const recoveryKey = await rotateAK(httpClient, { ...opts, excludeDeviceIds: [deviceId], orgKey })
  await rotateDEK(httpClient)
  return recoveryKey
}

// =============================================================================
// WS4 — Migrator (v1 → v2)
// =============================================================================

export type MigrateResult =
  | { outcome: 'migrated'; recoveryKey: string }
  | { outcome: 'followed' }
  | { outcome: 'awaiting-approval' }
  | { outcome: 'not-applicable' }
  | { outcome: 'not-eligible' }

export type MigrateToV2Options = {
  /** Dependency seam for the synced-devices read (tests). */
  listTrustedDevices?: () => Promise<TrustedDevicePublicKeys[]>
  /** Forwarded to the follower path taken on a 409 CAS-loss (tests). */
  getLegacyV1Sample?: () => Promise<LegacyV1Sample | null>
}

/**
 * Migrate this v1 account to v2 (WS4). Eligibility: `scheme_version == 1`, this
 * device holds the legacy CK (its v1 envelope unwraps and decrypts the canary),
 * and it is trusted. The migrator:
 *  1. absorbs the CK into the keyring as the reserved `"v1"` slot,
 *  2. mints a fresh primary DEK `"0"` + a fresh AK from a new recovery seed,
 *  3. wraps the keyring (both `"0"` and `"v1"`) under the new AK,
 *  4. writes a new-AK envelope for every trusted device,
 *  5. registers the signing key + kdf_salt + new canary,
 *  6. recovers the D1 possession proof (v1 CK decrypt of the canary, NO AAD),
 *  7. POSTs `/upgrade`, which CAS-flips `scheme_version 1→2` as its last step.
 *
 * The candidate AK/DEK/phrase are persisted ONLY on HTTP 200. On a 409 CAS-loss
 * (another device migrated first) nothing local is written and the flow falls
 * through to the follower path.
 */
export const migrateToV2 = async (httpClient: HttpClient, opts: MigrateToV2Options = {}): Promise<MigrateResult> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  if (metadata.scheme_version !== 1) {
    return { outcome: 'not-eligible' }
  }
  if (!metadata.canary_iv || !metadata.canary_ctext) {
    return { outcome: 'not-eligible' }
  }

  const keyPair = await getKeyPair()
  if (!keyPair) {
    return { outcome: 'not-eligible' }
  }

  // Absorb: this device's v1 envelope carries the legacy CK.
  const { wrappedCK: v1Envelope } = await fetchMyEnvelope(httpClient)
  const legacyCK = await unwrapLegacyCK(v1Envelope, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey).catch(() => null)
  if (!legacyCK) {
    return { outcome: 'not-eligible' }
  }

  // D1 possession proof: only the real CK recovers the v1 canary secret.
  const possessionProof = await recoverCanarySecretV1(legacyCK, metadata.canary_iv, metadata.canary_ctext)
  if (!possessionProof) {
    return { outcome: 'not-eligible' }
  }

  // Mint the new AK + fresh primary DEK '0'; absorb the CK as the '"v1"' slot.
  const seed = generateRecoverySeed()
  const recoveryKey = encodeRecoverySeed(seed)
  const kdfSalt = generateKdfSalt()
  const newAK = await deriveAKFromSeed(seed, kdfSalt, { extractable: true })

  const { dek: dek0, wrappedKey: wrappedDek0 } = await mintDEK(newAK)
  const wrappedV1 = await wrapDEK(legacyCK, newAK)

  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek0, getUserId(), initialKeyId)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  // Always cover THIS device from local key material — never rely solely on the
  // synced `devices` table, which may not have replicated this (freshly trusted)
  // device yet. Without self here, a migrator whose own row hasn't synced sends
  // an empty `envelopes` array and the upgrade is rejected (422 minItems).
  const trustedDevices = await (opts.listTrustedDevices ?? listTrustedDeviceKeys)()
  const self: TrustedDevicePublicKeys = {
    id: getDeviceId(),
    publicKey: await exportPublicKey(keyPair.ecdhPublicKey),
    mlkemPublicKey: exportMlKemPublicKey(keyPair.mlkemPublicKey),
  }
  const devicesToCover = trustedDevices.some((device) => device.id === self.id)
    ? trustedDevices
    : [self, ...trustedDevices]
  const envelopes = await buildDeviceEnvelopes(newAK, devicesToCover)
  const orgEnvelope = await buildOrgEnvelope(newAK, httpClient)

  const { nonce } = await fetchChallenge(httpClient, 'upgrade')

  try {
    const { key_version: keyVersion } = await postUpgrade(httpClient, {
      nonce,
      possessionProof,
      envelopes,
      wrappedKeys: [
        { keyId: initialKeyId, wrappedKey: wrappedDek0 },
        { keyId: legacyKeyId, wrappedKey: wrappedV1 },
      ],
      primaryKeyId: initialKeyId,
      canaryIv,
      canaryCtext,
      signingPublicKey: publicKeySpki,
      kdfSalt,
      orgEnvelope,
    })

    // Persist ONLY after the server accepted the flip (crash-safe re-entrancy).
    // Write the keyring + primary + version BEFORE the AK, so a persisted AK
    // always implies a complete keyring (a crash mid-write leaves no AK → the
    // device re-runs migration/follow rather than an AK-without-primary state).
    await stageWrappedDEKs([
      { keyId: initialKeyId, wrappedKey: wrappedDek0 },
      { keyId: legacyKeyId, wrappedKey: wrappedV1 },
    ])
    await storePrimaryKeyId(initialKeyId)
    await storeKeyVersion(keyVersion)
    await storeAK(await reimportAsNonExtractable(newAK))
    invalidateKeyringCache()

    return { outcome: 'migrated', recoveryKey }
  } catch (err) {
    // CAS-loss: another device migrated first. The candidate AK/phrase were
    // never persisted — re-classify as a follower and self-serve the winner's
    // envelope + keyring.
    if (err instanceof HttpError && err.response.status === 409) {
      // CAS-loss: another device migrated first. Surface the follower path's
      // ACTUAL outcome (it may be awaiting-approval / not-applicable if this
      // device's envelope isn't visible yet) rather than always 'followed'.
      return followToV2(httpClient, { getLegacyV1Sample: opts.getLegacyV1Sample })
    }
    throw err
  }
}

// =============================================================================
// WS5 — Follower (scheme_version == 2, no local AK)
// =============================================================================

/** One legacy v1 ciphertext sampled from local storage for the continuity check. */
export type LegacyV1Sample = { iv: string; ciphertext: string }

export type FollowToV2Options = {
  /**
   * Dependency seam (tests + skip control). Returns one legacy v1 ciphertext to
   * prove the incoming `"v1"` slot is the genuine CK, or null to skip the check.
   */
  getLegacyV1Sample?: () => Promise<LegacyV1Sample | null>
}

export type FollowResult = { outcome: 'followed' } | { outcome: 'awaiting-approval' } | { outcome: 'not-applicable' }

/** Parse a legacy v1 wire value `__enc:<iv>:<ct>` into its two base64 segments. */
const parseLegacyV1Value = (value: string): LegacyV1Sample | null => {
  if (!value.startsWith(encPrefix) || value.startsWith(encV2Prefix)) {
    return null
  }
  const [iv, ciphertext, ...extra] = value.slice(encPrefix.length).split(':')
  if (!iv || !ciphertext || extra.length > 0) {
    return null
  }
  return { iv, ciphertext }
}

/**
 * Default continuity-check sampler: scan the encrypted columns for one legacy
 * (`__enc:` but not `__enc:v2:`) value left behind by a fail-open decode. These
 * are the only local v1 ciphertexts (successful decodes store plaintext), so an
 * empty result means there is nothing to verify → the caller skips the check.
 * Any error is swallowed to a skip — the check is defense-in-depth atop the
 * server-side D1 proof and must never block unlock.
 */
const defaultGetLegacyV1Sample = async (): Promise<LegacyV1Sample | null> => {
  try {
    const db = getDb()
    for (const [table, columns] of Object.entries(encryptedColumnsMap)) {
      for (const column of columns) {
        const rows = await db.all<{ v: string | null }>(
          sql.raw(
            `SELECT "${column}" AS v FROM "${table}" ` +
              `WHERE "${column}" LIKE '${encPrefix}%' AND "${column}" NOT LIKE '${encV2Prefix}%' LIMIT 1`,
          ),
        )
        const value = rows[0]?.v
        const parsed = typeof value === 'string' ? parseLegacyV1Value(value) : null
        if (parsed) {
          return parsed
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * D1 follower continuity check (defense-in-depth): decrypt one synced-down
 * legacy v1 value with the freshly-staged `"v1"` slot and NO AAD. A GCM
 * auth-tag success proves the slot is the genuine CK; a failure means the
 * keyring was tampered with (hostile migrator) → reject. Skips when no legacy
 * sample is available (nothing to verify).
 */
const runContinuityCheck = async (ak: CryptoKey, getSample: () => Promise<LegacyV1Sample | null>): Promise<void> => {
  const sample = await getSample()
  if (!sample) {
    return
  }
  const wrappedV1 = await getDEK(legacyKeyId)
  if (!wrappedV1) {
    // No `"v1"` slot staged (account never had legacy data) — nothing to check.
    return
  }
  const v1Dek = await unwrapDEK(wrappedV1, ak)
  await decrypt({ iv: sample.iv, ciphertext: sample.ciphertext }, v1Dek).catch(() => {
    throw new Error('E2EE continuity check failed — the staged keyring could not decrypt legacy data')
  })
}

/**
 * Follow a migration performed by another device (WS5): `scheme_version == 2`
 * and this device has no local AK. Fetches this device's AK envelope (written
 * by the migrator), unwraps + stores the AK, stages the full keyring (the
 * `"v1"` slot rides along — followers NEVER absorb), and runs the continuity
 * check. Returns `awaiting-approval` when the envelope does not exist yet.
 */
export const followToV2 = async (httpClient: HttpClient, opts: FollowToV2Options = {}): Promise<FollowResult> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  if (metadata.scheme_version !== 2) {
    return { outcome: 'not-applicable' }
  }

  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found in IndexedDB')
  }

  const envelope = await fetchMyEnvelope(httpClient).catch((err: unknown) => {
    if (err instanceof HttpError && err.response.status === 404) {
      return null
    }
    throw err
  })
  if (!envelope) {
    return { outcome: 'awaiting-approval' }
  }

  const ak = await unwrapAK(envelope.wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey)
  await storeAK(ak)
  await stageKeyring(httpClient)

  await runContinuityCheck(ak, opts.getLegacyV1Sample ?? defaultGetLegacyV1Sample)

  return { outcome: 'followed' }
}

// =============================================================================
// WS6 — Idempotent migrator/follower entry point (wired at app init by Track F)
// =============================================================================

export type EnsureV2Result =
  | { outcome: 'migrated'; recoveryKey: string }
  | { outcome: 'followed' }
  | { outcome: 'already-v2' }
  | { outcome: 'awaiting-approval' }
  | { outcome: 'not-applicable' }

/**
 * Run the migrator/follower check once, idempotently (WS6). Decides from the
 * server metadata + local AK presence:
 *  - already has a local AK → `already-v2` (nothing to do)
 *  - `scheme_version == 1` → attempt migration (may fall through to follow)
 *  - `scheme_version == 2`, no local AK → follow
 *  - no metadata / not eligible → `not-applicable`
 */
export const ensureV2Encryption = async (
  httpClient: HttpClient,
  opts: FollowToV2Options = {},
): Promise<EnsureV2Result> => {
  const metadata = await fetchEncryptionMetadata(httpClient).catch((err: unknown) => {
    if (err instanceof HttpError && err.response.status === 404) {
      return null
    }
    throw err
  })
  if (!metadata) {
    return { outcome: 'not-applicable' }
  }

  if (await getAK()) {
    return { outcome: 'already-v2' }
  }

  if (metadata.scheme_version === 1) {
    const result = await migrateToV2(httpClient, { getLegacyV1Sample: opts.getLegacyV1Sample })
    // 'not-eligible' is a migrator-internal outcome; surface it as not-applicable.
    return result.outcome === 'not-eligible' ? { outcome: 'not-applicable' } : result
  }

  return followToV2(httpClient, opts)
}

// =============================================================================
// Flow G — Full wipe (clear all keys)
// =============================================================================

export const handleFullWipe = async (): Promise<void> => {
  await clearAllKeys()
  resetCodecState()
}
