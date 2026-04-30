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
  generateCK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  wrapCK,
  rewrapCK,
  unwrapCK,
  createCanary,
  verifyCanary,
  encodeRecoveryKey,
  decodeRecoveryKey,
  storeKeyPair,
  getKeyPair,
  storeCK,
  clearAllKeys,
  getCK,
  ValidationError,
  type StoredKeyPair,
} from '@/crypto'
import { getDeviceId } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'
import {
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  fetchCanary,
  denyDevice as denyDeviceApi,
  revokeDevice as revokeDeviceApi,
  type RegisterDeviceResponse,
} from '@/api/encryption'
import { invalidateCKCache, resetCodecState } from '@/db/encryption'

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
// Flow C — First device setup
// =============================================================================

/**
 * Complete first device setup: generate CK, canary, envelope, return recovery key.
 * Must be called after `registerThisDevice` (key pair already in IndexedDB).
 */
export const completeFirstDeviceSetup = async (httpClient: HttpClient): Promise<string> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found — call registerThisDevice first')
  }

  // Generate extractable CK for recovery key encoding
  const extractableCK = await generateCK(true)
  const recoveryKey = await encodeRecoveryKey(extractableCK)
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(extractableCK)

  // Wrap CK with own public keys (hybrid ECDH + ML-KEM)
  const wrappedCK = await wrapCK(extractableCK, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey)

  // Re-import as non-extractable for storage
  const ck = await reimportAsNonExtractable(extractableCK)

  const deviceId = getDeviceId()

  await storeEnvelope(httpClient, {
    deviceId,
    wrappedCK,
    canaryIv,
    canaryCtext,
    canarySecret,
  })

  // Store CK locally
  await storeCK(ck)
  invalidateCKCache()

  return recoveryKey
}

// =============================================================================
// Flow D (trusted device) — Approve another device
// =============================================================================

/**
 * Extract the canary secret by decrypting the server-stored canary with the local CK.
 * Used as proof-of-CK-possession for trust-sensitive operations (approve, deny, revoke).
 */
export const extractCanarySecret = async (httpClient: HttpClient): Promise<string> => {
  const { canaryIv, canaryCtext } = await fetchCanary(httpClient)
  const ck = await getCK()
  if (!ck) {
    throw new Error('Content key not found in IndexedDB')
  }
  const { valid, canarySecret } = await verifyCanary(ck, canaryIv, canaryCtext)
  if (!valid || !canarySecret) {
    throw new Error('Failed to verify canary — content key may be corrupted')
  }
  return canarySecret
}

/**
 * Approve a pending device by rewrapping the CK with its public keys and storing the envelope.
 * Fetches this device's own envelope from the server and rewraps — the locally stored
 * non-extractable CK is never touched, preserving its security properties.
 * Includes canary proof-of-CK-possession to prevent X-Device-ID spoofing.
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

  const [{ wrappedCK: myWrappedCK }, canarySecret] = await Promise.all([
    fetchMyEnvelope(httpClient),
    extractCanarySecret(httpClient),
  ])
  const pendingEcdhPub = await importPublicKey(pendingEcdhPublicKeyBase64)
  const pendingMlkemPub = importMlKemPublicKey(pendingMlkemPublicKeyBase64)
  const wrappedCK = await rewrapCK(
    myWrappedCK,
    keyPair.ecdhPrivateKey,
    keyPair.mlkemSecretKey,
    pendingEcdhPub,
    pendingMlkemPub,
  )

  await storeEnvelope(httpClient, {
    deviceId: pendingDeviceId,
    wrappedCK,
    canarySecret,
  })
}

/**
 * Deny a pending device with proof-of-CK-possession.
 * Extracts canary secret and sends it to prove the caller has the Content Key.
 */
export const denyDeviceWithProof = async (httpClient: HttpClient, deviceId: string): Promise<void> => {
  const canarySecret = await extractCanarySecret(httpClient)
  await denyDeviceApi(httpClient, deviceId, canarySecret)
}

/**
 * Revoke a device with proof-of-CK-possession.
 * Extracts canary secret when E2EE is active. Falls back to no proof for pre-E2EE users
 * (the backend skips canary verification when no encryption metadata exists).
 */
export const revokeDeviceWithProof = async (httpClient: HttpClient, deviceId: string): Promise<void> => {
  const canarySecret = await extractCanarySecret(httpClient).catch((err: unknown) => {
    if (err instanceof HttpError && err.response.status === 404) {
      return undefined
    }
    trackError(
      createHandleError('CANARY_EXTRACTION_FAILED', 'Failed to extract canary secret during device revocation', err),
    )
    throw err
  })
  await revokeDeviceApi(httpClient, deviceId, canarySecret)
}

// =============================================================================
// Flow D (new device) — Check approval and unwrap CK
// =============================================================================

/**
 * Check if this device has been approved (envelope exists) and unwrap the CK.
 * Returns true if CK was successfully unwrapped and stored, false if not yet approved.
 */
export const checkApprovalAndUnwrap = async (httpClient: HttpClient): Promise<boolean> => {
  try {
    const { wrappedCK } = await fetchMyEnvelope(httpClient)
    const keyPair = await getKeyPair()
    if (!keyPair) {
      throw new Error('Key pair not found in IndexedDB')
    }

    const ck = await unwrapCK(wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey)
    await storeCK(ck)
    invalidateCKCache()
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
 * Recover encryption access using a recovery key.
 * Verifies the key against the canary, then creates a new envelope for this device.
 */
export const recoverWithKey = async (httpClient: HttpClient, recoveryPhrase: string): Promise<void> => {
  // Fetch canary and verify recovery phrase
  const { canaryIv, canaryCtext } = await fetchCanary(httpClient)
  const ck = await decodeRecoveryKey(recoveryPhrase)
  const { valid, canarySecret } = await verifyCanary(ck, canaryIv, canaryCtext)
  if (!valid || !canarySecret) {
    throw new ValidationError('Invalid recovery key')
  }

  const keyPair = await getOrCreateKeyPair()

  // Register device and store envelope
  const publicKeyBase64 = await exportPublicKey(keyPair.ecdhPublicKey)
  const mlkemPublicKeyBase64 = exportMlKemPublicKey(keyPair.mlkemPublicKey)
  const deviceId = getDeviceId()

  await registerDevice(httpClient, {
    deviceId,
    publicKey: publicKeyBase64,
    mlkemPublicKey: mlkemPublicKeyBase64,
    name: getDeviceDisplayName(),
  })

  const wrappedCK = await wrapCK(ck, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey)
  await storeEnvelope(httpClient, {
    deviceId,
    wrappedCK,
    canarySecret,
  })

  // Re-import as non-extractable for local storage
  const nonExtractableCK = await reimportAsNonExtractable(ck)
  await storeCK(nonExtractableCK)
  invalidateCKCache()
}

// =============================================================================
// Flow G — Full wipe (clear all keys)
// =============================================================================

export const handleFullWipe = async (): Promise<void> => {
  await clearAllKeys()
  resetCodecState()
}
