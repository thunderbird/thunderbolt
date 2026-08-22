/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { createHandleError } from '@/lib/error-utils'
import { HttpError } from '@/lib/http'
import { trackError } from '@/lib/posthog'
import {
  generateAK,
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
  importOrgPublicKey,
  wrapAKForOrg,
  wrapDEK,
  unwrapDEK,
  mintDEK,
  rewrapKeyring,
  unwrapLegacyCK,
  createCanary,
  verifyCanary,
  recoverCanarySecretV1,
  deriveSigningKeyPair,
  signChallenge,
  decrypt,
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  deriveRecoveryKeyPairFromSeed,
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
  ValidationError,
  type StoredKeyPair,
} from '@/crypto'
import { getDeviceId } from '@/lib/auth-token'
import { markRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
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
  fetchEnvelopeTargets,
  postWrappedKey,
  fetchChallenge,
  postRotate,
  postUpgrade,
  denyDevice as denyDeviceApi,
  revokeDevice as revokeDeviceApi,
  setDeviceNodeId as setDeviceNodeIdApi,
  type RegisterDeviceResponse,
} from '@/api/encryption'
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
  type RecoverySlotRequest,
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
 * Wrap `ak` to the operator escrow public key (THU-804), if the deployment has
 * one configured. Returns `undefined` when org escrow is disabled — callers
 * spread it into request bodies, where `JSON.stringify` simply omits the field.
 * Always call this with the NEW AK of the flow (the same key being wrapped into
 * the device envelopes) — never the old one.
 */
export const buildOrgEnvelope = async (ak: CryptoKey, httpClient: HttpClient): Promise<string | undefined> => {
  const { enabled, publicKey } = await fetchOrgPublicKey(httpClient)
  if (!enabled || publicKey === null) {
    return undefined
  }
  return wrapAKForOrg(ak, await importOrgPublicKey(publicKey))
}

// =============================================================================
// Recovery slot — the recovery phrase as a virtual device
// =============================================================================

/**
 * The phrase-derived hybrid PUBLIC keys an AK is wrapped to. Structurally a
 * subset of `StoredKeyPair`, so a freshly derived recovery keypair passes
 * directly; a re-anchor passes keys imported from server metadata.
 */
type RecoveryPublicKeys = { ecdhPublicKey: CryptoKey; mlkemPublicKey: Uint8Array }

/**
 * Wrap `ak` for the recovery phrase's virtual device. Wrapping needs only the
 * public halves, which is what lets any trusted device rotate the AK without
 * ever seeing the phrase.
 */
const buildRecoverySlot = async (ak: CryptoKey, recovery: RecoveryPublicKeys): Promise<RecoverySlotRequest> => ({
  recoveryEcdhPublicKey: await exportPublicKey(recovery.ecdhPublicKey),
  recoveryMlkemPublicKey: exportMlKemPublicKey(recovery.mlkemPublicKey),
  recoveryWrappedAK: await wrapAK(ak, recovery.ecdhPublicKey, recovery.mlkemPublicKey),
})

/**
 * How a write path anchors the recovery slot. `kdfSalt` travels with the plan
 * because it is what re-derives the keypair from the phrase: minting a new
 * phrase mints a new salt, and re-anchoring MUST resubmit the stored one.
 */
type RecoveryPlan = { kdfSalt: string; publicKeys: RecoveryPublicKeys } & (
  | { mode: 'keep' }
  | { mode: 'new'; recoveryPhrase: string }
)

/** Mint a fresh 24-word phrase and the recovery keypair it derives. */
const mintRecoveryPlan = async (): Promise<Extract<RecoveryPlan, { mode: 'new' }>> => {
  const seed = generateRecoverySeed()
  const recoveryPhrase = encodeRecoverySeed(seed)
  const kdfSalt = generateKdfSalt()
  return { mode: 'new', recoveryPhrase, kdfSalt, publicKeys: await deriveRecoveryKeyPairFromSeed(seed, kdfSalt) }
}

/**
 * Re-anchor to the phrase the user already has: read the stored recovery public
 * keys and salt so the new AK is wrapped to the SAME virtual device. Null
 * columns on a v2 account mean the recovery slot was never written — fail loud
 * rather than silently minting a phrase the user would never be shown.
 */
const readStoredRecoveryPlan = async (httpClient: HttpClient): Promise<RecoveryPlan> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  if (!metadata.kdf_salt || !metadata.recovery_ecdh_public_key || !metadata.recovery_mlkem_public_key) {
    throw new Error(
      'Account has no recovery slot — the account key cannot be rotated without changing the recovery phrase',
    )
  }
  return {
    mode: 'keep',
    kdfSalt: metadata.kdf_salt,
    publicKeys: {
      ecdhPublicKey: await importPublicKey(metadata.recovery_ecdh_public_key),
      mlkemPublicKey: importMlKemPublicKey(metadata.recovery_mlkem_public_key),
    },
  }
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

/** Fetched keyring + pointers, written to IndexedDB as one unit. */
type FetchedKeyring = {
  keys: Array<{ key_id: KeyId; wrapped_key: string }>
  primaryKeyId: KeyId
  keyVersion: number
}

/**
 * Re-fetch this device's envelope, unwrap the AK it carries, and store it.
 * Split out of `refreshAK` so `stageKeyring` can adopt a rotated AK without
 * recursing back through it.
 */
const adoptEnvelopeAK = async (httpClient: HttpClient): Promise<void> => {
  const { wrappedCK } = await fetchMyEnvelope(httpClient)
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found in IndexedDB')
  }
  await storeAK(await unwrapAK(wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey))
}

/**
 * Does the locally stored AK still open the keyring the server just handed us?
 * A `false` means the AK was rotated elsewhere and this device has not caught
 * up yet. No local AK (first setup, mid-recovery) is not a contradiction —
 * there is nothing to be stale.
 */
const keyringUnwrapsUnderLocalAK = async (keyring: FetchedKeyring): Promise<boolean> => {
  const ak = await getAK()
  if (!ak) {
    return true
  }
  const probe = keyring.keys.find((key) => key.key_id === keyring.primaryKeyId) ?? keyring.keys[0]
  if (!probe) {
    return true
  }
  return unwrapDEK(probe.wrapped_key, ak).then(
    () => true,
    () => false,
  )
}

const applyKeyring = async (keyring: FetchedKeyring): Promise<void> => {
  await stageWrappedDEKs(keyring.keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key })))
  await storePrimaryKeyId(keyring.primaryKeyId)
  await storeKeyVersion(keyring.keyVersion)
  invalidateKeyringCache()
}

/**
 * Stage the full server-side keyring into IndexedDB for the SharedWorker: fetch
 * every wrapped DEK (including the `"v1"` slot), refresh the primary key_id +
 * key_version from metadata, and invalidate the codec caches so encoders pick
 * up the new state.
 *
 * INVARIANT: never leave IndexedDB holding DEKs the stored AK cannot unwrap.
 * The server wraps every DEK under the CURRENT AK, so staging blindly onto a
 * device whose AK was rotated elsewhere produces a keyring that opens nothing —
 * every decode then fails open to raw ciphertext until something escalates to
 * `unwrap-failed`. Probing the primary before the write and adopting the
 * rotated AK first keeps the two halves consistent by construction.
 *
 * Track F wires the responder's zero-arg `stageKeyring: () => Promise<void>`
 * with `() => stageKeyring(client)`.
 */
export const stageKeyring = async (httpClient: HttpClient): Promise<void> => {
  const [{ keys }, metadata] = await Promise.all([fetchWrappedKeys(httpClient), fetchEncryptionMetadata(httpClient)])
  const keyring: FetchedKeyring = {
    keys,
    primaryKeyId: metadata.primary_key_id,
    keyVersion: metadata.key_version,
  }

  if (!(await keyringUnwrapsUnderLocalAK(keyring))) {
    await adoptEnvelopeAK(httpClient)
  }
  await applyKeyring(keyring)
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
  await adoptEnvelopeAK(httpClient)
  await stageKeyring(httpClient)
}

// =============================================================================
// Flow C — First device setup
// =============================================================================

/**
 * Complete first device setup: generate a random AK, mint DEK '0', create the
 * canary + signing keypair, wrap the AK for this device AND for the recovery
 * phrase's virtual device, and store everything on the server in one atomic
 * bootstrap envelope. Returns the 24-word recovery key. Must be called after
 * `registerThisDevice` (key pair already in IndexedDB).
 */
export const completeFirstDeviceSetup = async (httpClient: HttpClient): Promise<string> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found — call registerThisDevice first')
  }

  const recovery = await mintRecoveryPlan()
  // Random, not phrase-derived: the phrase is a virtual device that receives its
  // own envelope, so the AK can later rotate without invalidating it.
  // Extractable only transiently — it must be wrapped into the two envelopes.
  const extractableAK = await generateAK(true)

  const { dek, wrappedKey } = await mintDEK(extractableAK)
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek, getUserId(), initialKeyId)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  const wrappedCK = await wrapAK(extractableAK, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey)
  const recoverySlot = await buildRecoverySlot(extractableAK, recovery.publicKeys)
  const ak = await reimportAsNonExtractable(extractableAK)

  await storeEnvelope(httpClient, {
    deviceId: getDeviceId(),
    wrappedCK,
    canaryIv,
    canaryCtext,
    signingPublicKey: publicKeySpki,
    kdfSalt: recovery.kdfSalt,
    wrappedKeys: [{ keyId: initialKeyId, wrappedKey }],
    ...recoverySlot,
    orgEnvelope: await buildOrgEnvelope(extractableAK, httpClient),
  })

  // AK stored LAST so its presence always implies a complete local keyring.
  await storeDEK(initialKeyId, wrappedKey)
  await storePrimaryKeyId(initialKeyId)
  await storeKeyVersion(1)
  await storeAK(ak)
  invalidateKeyringCache()

  // Marked at the mint, not at the display: the phrase below lives only in
  // component state, so a reload before the user confirms would otherwise lose
  // the account's only recovery credential with no trace that one was owed.
  markRecoveryPhrasePending()

  return recovery.recoveryPhrase
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
 * Recover encryption access using the 24-word recovery key: re-derive the
 * recovery keypair (seed + server kdf_salt), open the recovery envelope to get
 * the AK, verify it against the canary via DEK '0', then self-approve this
 * device with a challenge proof (pending devices may fetch wrapped keys and
 * challenges — the signature is the gate).
 */
export const recoverWithKey = async (httpClient: HttpClient, recoveryPhrase: string): Promise<void> => {
  const seed = decodeRecoveryKey(recoveryPhrase)

  const metadata = await fetchEncryptionMetadata(httpClient)
  if (
    metadata.signing_public_key == null ||
    metadata.kdf_salt == null ||
    metadata.recovery_ecdh_public_key == null ||
    metadata.recovery_mlkem_public_key == null ||
    metadata.recovery_wrapped_ak == null ||
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

  const recoveryKeyPair = await deriveRecoveryKeyPairFromSeed(seed, metadata.kdf_salt)

  // Cheap, offline wrong-phrase check: the derivation is deterministic, so a
  // correct phrase reproduces the stored public keys byte for byte. Done before
  // the registration round trip so a typo costs nothing.
  if (
    (await exportPublicKey(recoveryKeyPair.ecdhPublicKey)) !== metadata.recovery_ecdh_public_key ||
    exportMlKemPublicKey(recoveryKeyPair.mlkemPublicKey) !== metadata.recovery_mlkem_public_key
  ) {
    throw new ValidationError('Invalid recovery key')
  }

  const ak = await unwrapAK(
    metadata.recovery_wrapped_ak,
    recoveryKeyPair.ecdhPrivateKey,
    recoveryKeyPair.mlkemSecretKey,
  )

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

  // Verify the recovered AK against the account: unwrap DEK '0' and decrypt the
  // canary. Catches a recovery slot that no longer matches the live keyring.
  const { wrapped_key: wrappedDEK0 } = await fetchWrappedKey(httpClient, initialKeyId)
  const dek0 = await unwrapDEK(wrappedDEK0, ak).catch(() => null)
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

  // Self-approve: re-wrap the recovery envelope for our own keys (the stored AK
  // stays non-extractable) and prove key possession.
  const wrappedCK = await rewrapAK(
    metadata.recovery_wrapped_ak,
    recoveryKeyPair.ecdhPrivateKey,
    recoveryKeyPair.mlkemSecretKey,
    keyPair.ecdhPublicKey,
    keyPair.mlkemPublicKey,
  )
  const proof = await buildProof(httpClient, 'approve', canarySecret)
  await storeEnvelope(httpClient, { deviceId, wrappedCK, proof })

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
 * The devices this rotation/upgrade must cover, read from the SERVER rather than
 * the local synced `devices` table.
 *
 * The server validates coverage against its own device rows, so deriving the set
 * from a PowerSync-replicated copy meant the two could disagree: a peer that had
 * not replicated locally yet was silently omitted, and the whole payload came
 * back 400 "must cover every envelope-capable device". Two devices migrating at
 * once hit this simultaneously and neither could ever win — the account stayed on
 * v1. Asking the server removes the class of bug rather than narrowing the race.
 *
 * Devices that cannot hold an envelope (no public keys — bridges, and v1 devices
 * that never published v2 keys) are excluded by the endpoint itself, using the
 * same predicate the validator applies.
 */
const listTrustedDeviceKeys = async (httpClient: HttpClient): Promise<TrustedDevicePublicKeys[]> => {
  const { devices } = await fetchEnvelopeTargets(httpClient)
  return devices.map((device) => ({
    id: device.device_id,
    publicKey: device.public_key,
    mlkemPublicKey: device.mlkem_public_key,
  }))
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
}

/** Resolves the recovery anchor for one rotation. Invoked AFTER the proof is built. */
type ResolveRecoveryPlan = () => Promise<RecoveryPlan>

/**
 * The one AK rotation (0 rows re-encrypted): generate a random new AK, re-wrap
 * EVERY DEK on the live keyring under it, re-issue an envelope for every live
 * trusted device AND for the recovery phrase's virtual device, and replace the
 * canary + signing keypair — submitted atomically via POST /encryption/rotate.
 *
 * `resolveRecovery` decides whether the phrase survives: 'keep' re-anchors to
 * the stored recovery public keys, 'new' anchors to a freshly minted phrase.
 *
 * On a 4xx (stale local state, e.g. a concurrent rotation) the local AK/keyring
 * are refreshed and a retryable `RotationStaleError` is thrown.
 */
const runAKRotation = async (
  httpClient: HttpClient,
  resolveRecovery: ResolveRecoveryPlan,
  opts: RotateAKOptions,
): Promise<void> => {
  // Proof FIRST — it must be signed with the OLD signing key, which the server
  // still holds until the rotate transaction commits.
  const proof = await buildProof(httpClient, 'rotate')

  const oldAK = await getAK()
  if (!oldAK) {
    throw new Error('Account key not found in IndexedDB')
  }

  const recovery = await resolveRecovery()
  // Random and machine-only — wrapping it to the recovery public keys needs no
  // private key, which is what makes a phrase-preserving rotation possible.
  const newAK = await generateAK(true)

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
  const trustedDevices = await (opts.listTrustedDevices ?? (() => listTrustedDeviceKeys(httpClient)))()
  const envelopes = await buildDeviceEnvelopes(newAK, trustedDevices, opts.excludeDeviceIds)
  const recoverySlot = await buildRecoverySlot(newAK, recovery.publicKeys)

  // New canary under DEK '0' (the DEK itself did not change) + new signing
  // keypair. Independent of the phrase, so this happens in BOTH modes: a
  // revoked device knows the old canary secret and could otherwise keep forging
  // approve/revoke/rotate proofs.
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek0, getUserId(), initialKeyId)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  // Built OUTSIDE the try below: a failed org-key fetch must surface as-is, not
  // masquerade as a stale-rotation 4xx.
  const orgEnvelope = await buildOrgEnvelope(newAK, httpClient)

  try {
    await postRotate(httpClient, {
      proof,
      envelopes,
      wrappedKeys,
      canaryIv,
      canaryCtext,
      signingPublicKey: publicKeySpki,
      kdfSalt: recovery.kdfSalt,
      ...recoverySlot,
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

  // PAST THE POINT OF NO RETURN. `postRotate` succeeded, so the server has
  // already replaced the AK, canary and signing key. In 'new' mode this is what
  // protects the caller's only copy of the freshly minted phrase: nothing here
  // may throw, or the account is left with a phrase nobody knows. ('keep' mode
  // has no unsaved secret to lose, but the same staging failure must not
  // surface as a rotation failure either.) Local staging failing is
  // independently recoverable — the codec's unwrap-failure path calls
  // `refreshAK` and re-stages on next use — so it is logged, not propagated.
  try {
    await storeAK(await reimportAsNonExtractable(newAK))
    await stageWrappedDEKs(wrappedKeys)
    invalidateKeyringCache()
  } catch (err) {
    console.error('[e2ee] AK rotation committed but local key staging failed — keys will re-stage on next use:', err)
  }

  // Only a freshly minted phrase is owed to the user; a silent rotation must not
  // nag them about a phrase that never changed.
  if (recovery.mode === 'new') {
    markRecoveryPhrasePending()
  }
}

/**
 * Silent AK rotation: re-anchors the recovery slot to the account's EXISTING
 * recovery public keys, so the user's 24-word phrase keeps working and is never
 * shown. This is what device revocation uses — rotating the AK is the only step
 * that cryptographically locks a revoked device out of the keyring.
 *
 * Throws if the account has no stored recovery slot (see `readStoredRecoveryPlan`);
 * throws a retryable `RotationStaleError` when the server rejects a stale payload.
 */
export const rotateAccountKey = (httpClient: HttpClient, opts: RotateAKOptions = {}): Promise<void> =>
  runAKRotation(httpClient, () => readStoredRecoveryPlan(httpClient), opts)

/**
 * Explicit recovery-phrase change: rotates the AK AND re-anchors the recovery
 * slot to a freshly minted phrase, so the old phrase stops working. Returns the
 * NEW 24-word phrase — the caller MUST display it, it exists nowhere else.
 */
export const changeRecoveryPhrase = async (
  httpClient: HttpClient,
  opts: Pick<RotateAKOptions, 'listTrustedDevices'> = {},
): Promise<string> => {
  const recovery = await mintRecoveryPlan()
  await runAKRotation(httpClient, async () => recovery, opts)
  return recovery.recoveryPhrase
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
 * Device revocation double-rotation: cut server access, rotate the DEK (future
 * writes use a key_id the revoked device never held), then rotate the AK
 * (locking it out of the keyring — its envelope is gone and never re-issued).
 * Silent for the user: the recovery slot is re-anchored to the phrase they
 * already hold, so nothing needs to be shown.
 *
 * ORDER IS LOAD-BEARING. The AK rotation is the step that replaces the account's
 * canary and signing key, and the only one that is unrecoverable from a partial
 * run — the local AK and the server's diverge until a refresh. So it goes LAST:
 * a failure in any earlier step aborts with the account fully intact.
 *
 * The revoked device cannot exploit the window where the new DEK is still
 * wrapped under the old AK it holds: revocation already precedes it, and the
 * keyring endpoints reject revoked callers.
 *
 * Remaining devices self-heal: their next decode of post-rotation data hits a
 * DEK that won't unwrap under their old AK, which triggers the responder's
 * `refreshAK` + re-staging path.
 */
export const revokeDeviceAndRotate = async (
  httpClient: HttpClient,
  deviceId: string,
  opts: Pick<RotateAKOptions, 'listTrustedDevices'> = {},
): Promise<void> => {
  await revokeDeviceWithProof(httpClient, deviceId)
  await rotateDEK(httpClient)
  await rotateAccountKey(httpClient, { ...opts, excludeDeviceIds: [deviceId] })
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
 *  2. mints a fresh primary DEK `"0"` + a fresh random AK + a new recovery phrase,
 *  3. wraps the keyring (both `"0"` and `"v1"`) under the new AK,
 *  4. writes a new-AK envelope for every trusted device and for the phrase,
 *  5. registers the signing key + kdf_salt + recovery slot + new canary,
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
  const recovery = await mintRecoveryPlan()
  const newAK = await generateAK(true)

  const { dek: dek0, wrappedKey: wrappedDek0 } = await mintDEK(newAK)
  const wrappedV1 = await wrapDEK(legacyCK, newAK)

  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek0, getUserId(), initialKeyId)
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

  // Always cover THIS device from local key material — never rely solely on the
  // synced `devices` table, which may not have replicated this (freshly trusted)
  // device yet. Without self here, a migrator whose own row hasn't synced sends
  // an empty `envelopes` array and the upgrade is rejected (422 minItems).
  const trustedDevices = await (opts.listTrustedDevices ?? (() => listTrustedDeviceKeys(httpClient)))()
  const self: TrustedDevicePublicKeys = {
    id: getDeviceId(),
    publicKey: await exportPublicKey(keyPair.ecdhPublicKey),
    mlkemPublicKey: exportMlKemPublicKey(keyPair.mlkemPublicKey),
  }
  const devicesToCover = trustedDevices.some((device) => device.id === self.id)
    ? trustedDevices
    : [self, ...trustedDevices]
  const envelopes = await buildDeviceEnvelopes(newAK, devicesToCover)
  const recoverySlot = await buildRecoverySlot(newAK, recovery.publicKeys)

  const { nonce } = await fetchChallenge(httpClient, 'upgrade')

  // Built OUTSIDE the try below: a failed org-key fetch must surface as-is, not
  // be re-classified as a 409 CAS-loss.
  const orgEnvelope = await buildOrgEnvelope(newAK, httpClient)

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
      kdfSalt: recovery.kdfSalt,
      ...recoverySlot,
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

    markRecoveryPhrasePending()

    return { outcome: 'migrated', recoveryKey: recovery.recoveryPhrase }
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
 * legacy v1 value with the candidate `"v1"` slot and NO AAD. A GCM auth-tag
 * success proves the slot is the genuine CK; a failure means the keyring was
 * tampered with (hostile migrator) → reject. Skips when no legacy sample is
 * available (nothing to verify).
 *
 * Takes the candidate keyring as an ARGUMENT rather than reading the staged
 * copy: it must be possible to run this before anything is written to
 * IndexedDB. A rejected keyring that had already been persisted would leave the
 * AK behind, and `ensureV2Encryption` short-circuits to `already-v2` on AK
 * presence — so the check would never run again on that device.
 */
const runContinuityCheck = async (
  ak: CryptoKey,
  keyring: WrappedKeyEntry[],
  getSample: () => Promise<LegacyV1Sample | null>,
): Promise<void> => {
  const sample = await getSample()
  if (!sample) {
    return
  }
  const wrappedV1 = keyring.find((entry) => entry.keyId === legacyKeyId)?.wrappedKey
  if (!wrappedV1) {
    // No `"v1"` slot (account never had legacy data) — nothing to check.
    return
  }
  const v1Dek = await unwrapDEK(wrappedV1, ak)
  await decrypt({ iv: sample.iv, ciphertext: sample.ciphertext }, v1Dek).catch(() => {
    throw new Error('E2EE continuity check failed — the staged keyring could not decrypt legacy data')
  })
}

/**
 * Follow a migration performed by another device (WS5): `scheme_version == 2`
 * and this device has no local AK. Fetches this device's AK envelope (written by
 * the migrator), unwraps the AK, VERIFIES continuity, and only then persists the
 * AK + keyring (the `"v1"` slot rides along — followers NEVER absorb). Returns
 * `awaiting-approval` when the envelope does not exist yet.
 *
 * Verify-then-persist is the whole point of the ordering: the continuity check
 * exists to reject a keyring planted by a hostile migrator, and persisting first
 * defeated it. A rejected keyring left the AK in IndexedDB, and
 * `ensureV2Encryption` returns `already-v2` whenever an AK is present — so the
 * next boot skipped straight past the check that had just failed, permanently.
 * Nothing is written until the keyring proves it can read this account's legacy
 * data, so a rejection leaves the device untouched and the check re-runs.
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

  const { keys } = await fetchWrappedKeys(httpClient)
  const keyring: WrappedKeyEntry[] = keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key }))
  await runContinuityCheck(ak, keyring, opts.getLegacyV1Sample ?? defaultGetLegacyV1Sample)

  await storeAK(ak)
  await stageKeyring(httpClient)

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
