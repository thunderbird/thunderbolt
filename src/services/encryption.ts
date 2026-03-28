import type { KyInstance } from 'ky'
import {
  generateKeyPair,
  generateCK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
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
  clearCK,
  clearAllKeys,
} from '@/crypto'
import { getDeviceId } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'
import {
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  fetchCanary,
  type RegisterDeviceResponse,
} from '@/api/encryption'
import { invalidateCKCache } from '@/db/encryption'

// =============================================================================
// Detecting step — register device and store key pair
// =============================================================================

/**
 * Register this device with the server and store the key pair.
 * Idempotent: reuses existing key pair from IndexedDB if present.
 * Returns the registration response so the caller can determine first vs additional device.
 */
export const registerThisDevice = async (httpClient: KyInstance): Promise<RegisterDeviceResponse> => {
  let keyPair = await getKeyPair()
  if (!keyPair) {
    keyPair = await generateKeyPair()
    await storeKeyPair(keyPair.privateKey, keyPair.publicKey)
  }

  const publicKeyBase64 = await exportPublicKey(keyPair.publicKey)
  const deviceId = getDeviceId()

  return registerDevice(httpClient, {
    deviceId,
    publicKey: publicKeyBase64,
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
export const completeFirstDeviceSetup = async (httpClient: KyInstance): Promise<string> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found — call registerThisDevice first')
  }

  // Generate extractable CK for recovery key encoding
  const extractableCK = await generateCK(true)
  const recoveryKey = await encodeRecoveryKey(extractableCK)
  const { canaryIv, canaryCtext } = await createCanary(extractableCK)

  // Wrap CK with own public key and store on server
  const wrappedCK = await wrapCK(extractableCK, keyPair.publicKey)

  // Re-import as non-extractable for storage
  const ck = await reimportAsNonExtractable(extractableCK)

  const deviceId = getDeviceId()

  await storeEnvelope(httpClient, {
    deviceId,
    wrappedCK,
    canaryIv,
    canaryCtext,
  })

  // Store CK locally
  await storeCK(ck)

  return recoveryKey
}

// =============================================================================
// Flow D (trusted device) — Approve another device
// =============================================================================

/**
 * Approve a pending device by rewrapping the CK with its public key and storing the envelope.
 * Fetches this device's own envelope from the server and rewraps — the locally stored
 * non-extractable CK is never touched, preserving its security properties.
 */
export const approveDevice = async (
  httpClient: KyInstance,
  pendingDeviceId: string,
  pendingPublicKeyBase64: string,
): Promise<void> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found in IndexedDB')
  }

  const { wrappedCK: myWrappedCK } = await fetchMyEnvelope(httpClient)
  const pendingPublicKey = await importPublicKey(pendingPublicKeyBase64)
  const wrappedCK = await rewrapCK(myWrappedCK, keyPair.privateKey, pendingPublicKey)

  await storeEnvelope(httpClient, {
    deviceId: pendingDeviceId,
    wrappedCK,
  })
}

// =============================================================================
// Flow D (new device) — Check approval and unwrap CK
// =============================================================================

/**
 * Check if this device has been approved (envelope exists) and unwrap the CK.
 * Returns true if CK was successfully unwrapped and stored, false if not yet approved.
 */
export const checkApprovalAndUnwrap = async (httpClient: KyInstance): Promise<boolean> => {
  try {
    const { wrappedCK } = await fetchMyEnvelope(httpClient)
    const keyPair = await getKeyPair()
    if (!keyPair) {
      throw new Error('Key pair not found in IndexedDB')
    }

    const ck = await unwrapCK(wrappedCK, keyPair.privateKey)
    await storeCK(ck)
    return true
  } catch (err) {
    // 404 = not yet approved, return false so caller can retry
    if (err instanceof Error && 'response' in err) {
      const status = (err as Error & { response: { status: number } }).response.status
      if (status === 404) {
        return false
      }
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
export const recoverWithKey = async (httpClient: KyInstance, recoveryPhrase: string): Promise<void> => {
  // Fetch canary and verify recovery phrase
  const { canaryIv, canaryCtext } = await fetchCanary(httpClient)
  const ck = await decodeRecoveryKey(recoveryPhrase)
  const valid = await verifyCanary(ck, canaryIv, canaryCtext)
  if (!valid) {
    throw new Error('Invalid recovery key')
  }

  // Ensure we have a key pair
  let keyPair = await getKeyPair()
  if (!keyPair) {
    keyPair = await generateKeyPair()
    await storeKeyPair(keyPair.privateKey, keyPair.publicKey)
  }

  // Register device and store envelope
  const publicKeyBase64 = await exportPublicKey(keyPair.publicKey)
  const deviceId = getDeviceId()

  await registerDevice(httpClient, {
    deviceId,
    publicKey: publicKeyBase64,
    name: getDeviceDisplayName(),
  })

  const wrappedCK = await wrapCK(ck, keyPair.publicKey)
  await storeEnvelope(httpClient, {
    deviceId,
    wrappedCK,
    canaryIv,
    canaryCtext,
  })

  // Re-import as non-extractable for local storage
  const nonExtractableCK = await reimportAsNonExtractable(ck)
  await storeCK(nonExtractableCK)
}

// =============================================================================
// Flow G — Sign out (clear CK, keep key pair)
// =============================================================================

export const handleSignOut = async (): Promise<void> => {
  await clearCK()
  invalidateCKCache()
}

// =============================================================================
// Flow H — Full wipe (clear all keys)
// =============================================================================

export const handleFullWipe = async (): Promise<void> => {
  await clearAllKeys()
  invalidateCKCache()
}
