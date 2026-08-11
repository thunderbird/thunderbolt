/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { HttpError } from '@/lib/http'
import type {
  ChallengeOperation,
  ChallengeProof,
  ChallengeResponse,
  EncryptionMetadataResponse,
  KeyId,
  RotateRequest,
  RotateResponse,
  WrappedKeyEntry,
  WrappedKeyResponse,
  WrappedKeysListResponse,
} from '@shared/e2ee-types'

// =============================================================================
// Response types (matching backend)
// =============================================================================

export type RegisterDeviceResponse = { trusted: true; envelope: string | null } | { trusted: false }

type StoreEnvelopeResponse = { trusted: true }

type FetchEnvelopeResponse = { trusted: boolean; wrappedCK: string }

/**
 * GET /encryption/canary as the backend actually serves it: v1 accounts (rows
 * predating v2) carry NULL `signing_public_key`/`kdf_salt` — that null is the
 * frontend's v1-detection signal (beta reset, G3).
 */
export type EncryptionMetadata = Omit<EncryptionMetadataResponse, 'signing_public_key' | 'kdf_salt'> & {
  signing_public_key: string | null
  kdf_salt: string | null
}

// =============================================================================
// Device registration + envelopes
// =============================================================================

/** Register (or re-identify) this device with the server. */
export const registerDevice = async (
  httpClient: HttpClient,
  params: { deviceId: string; publicKey: string; mlkemPublicKey: string; name?: string },
): Promise<RegisterDeviceResponse> => httpClient.post('devices', { json: params }).json<RegisterDeviceResponse>()

/**
 * First-device bootstrap payload: the full atomic v2 setup (envelope + canary +
 * signing public key + KDF salt + initial wrapped keyring) in one request.
 */
export type BootstrapEnvelopeParams = {
  deviceId: string
  /** Hybrid envelope carrying the AK (field name kept from v1 for wire compatibility). */
  wrappedCK: string
  canaryIv: string
  canaryCtext: string
  /** Base64 SPKI ECDSA P-256 public key derived from the canary secret. */
  signingPublicKey: string
  /** Base64 random salt for the recovery-seed KDF. */
  kdfSalt: string
  /** Must include key_id '0' (`initialKeyId`). */
  wrappedKeys: WrappedKeyEntry[]
}

/** Approval / self-recovery payload: gated by a ChallengeProof (operation 'approve'). */
export type ProofEnvelopeParams = {
  deviceId: string
  /** Hybrid envelope carrying the AK (field name kept from v1 for wire compatibility). */
  wrappedCK: string
  proof: ChallengeProof
}

export type StoreEnvelopeParams = BootstrapEnvelopeParams | ProofEnvelopeParams

/**
 * Store a device envelope (carries the AK). Two variants:
 * - bootstrap (first device, caller == target, no proof) — all-in-one atomic setup
 * - approve / self-recovery — requires a ChallengeProof with operation 'approve'
 */
export const storeEnvelope = async (
  httpClient: HttpClient,
  params: StoreEnvelopeParams,
): Promise<StoreEnvelopeResponse> => {
  const { deviceId, ...body } = params
  return httpClient
    .post(`devices/${encodeURIComponent(deviceId)}/envelope`, { json: body })
    .json<StoreEnvelopeResponse>()
}

/** Fetch the wrapped account key (envelope) for the current device. */
export const fetchMyEnvelope = async (httpClient: HttpClient): Promise<FetchEnvelopeResponse> =>
  httpClient.get('devices/me/envelope').json<FetchEnvelopeResponse>()

/** Cancel this device's pending approval state (called by the pending device itself). */
export const cancelPending = async (httpClient: HttpClient): Promise<void> => {
  await httpClient.post('devices/me/cancel-pending')
}

// =============================================================================
// Encryption metadata + wrapped-DEK keyring
// =============================================================================

/**
 * Fetch the encryption metadata (canary, kdf_salt, signing key, key_version,
 * primary_key_id). 404 = encryption not set up. Rides the poll clients already
 * do at unlock — `key_version`/`primary_key_id` detect rotations.
 */
export const fetchEncryptionMetadata = async (httpClient: HttpClient): Promise<EncryptionMetadata> =>
  httpClient.get('encryption/canary').json<EncryptionMetadata>()

/** Check if the user has encryption set up (metadata exists on server). */
export const checkCanaryExists = async (httpClient: HttpClient): Promise<boolean> => {
  try {
    await fetchEncryptionMetadata(httpClient)
    return true
  } catch (err) {
    if (err instanceof HttpError && err.response.status === 404) {
      return false
    }
    throw err
  }
}

/** Fetch the full wrapped-DEK keyring. Allowed for any non-revoked device (including pending). */
export const fetchWrappedKeys = async (httpClient: HttpClient): Promise<WrappedKeysListResponse> =>
  httpClient.get('encryption/keys').json<WrappedKeysListResponse>()

/** Fetch one wrapped DEK by key_id. Allowed for any non-revoked device (recovery relies on this). */
export const fetchWrappedKey = async (httpClient: HttpClient, keyId: KeyId): Promise<WrappedKeyResponse> =>
  httpClient.get(`encryption/keys/${encodeURIComponent(keyId)}`).json<WrappedKeyResponse>()

/**
 * Mint a NEW key_id on the server-side keyring (DEK rotation / workspace DEK).
 * Trusted device only; idempotent per key_id — never overwrites.
 */
export const postWrappedKey = async (
  httpClient: HttpClient,
  params: { keyId: KeyId; wrappedKey: string; setPrimary?: boolean },
): Promise<{ key_id: KeyId }> => httpClient.post('encryption/keys', { json: params }).json<{ key_id: KeyId }>()

// =============================================================================
// Challenge-response + rotation
// =============================================================================

/** Request a single-use challenge nonce bound to (user, operation, this device). */
export const fetchChallenge = async (
  httpClient: HttpClient,
  operation: ChallengeOperation,
): Promise<ChallengeResponse> =>
  httpClient.get('encryption/challenge', { searchParams: { operation } }).json<ChallengeResponse>()

/**
 * Atomic AK rotation: replaces every trusted device's envelope, re-wraps the
 * FULL keyring, replaces canary + signing key + kdf_salt, bumps key_version.
 * The server rejects partial keyring or envelope coverage — build the payload
 * from live server state (see services `rotateAK`).
 */
export const postRotate = async (httpClient: HttpClient, body: RotateRequest): Promise<RotateResponse> =>
  httpClient.post('encryption/rotate', { json: body }).json<RotateResponse>()

/**
 * Beta reset for v1 accounts (signing_public_key IS NULL): wipes v1 encryption
 * state so a fresh v2 setup can run. v2 accounts get 409.
 */
export const resetV1Encryption = async (httpClient: HttpClient): Promise<void> => {
  await httpClient.post('encryption/reset')
}

// =============================================================================
// Proof-gated device management
// =============================================================================

/** Deny a pending device (called by a trusted device). Gated by a 'deny' challenge proof. */
export const denyDevice = async (httpClient: HttpClient, deviceId: string, proof: ChallengeProof): Promise<void> => {
  await httpClient.post(`devices/${encodeURIComponent(deviceId)}/deny`, { json: { proof } })
}

/**
 * Revoke a device. Gated by a 'revoke' challenge proof when E2EE v2 is active;
 * pre-E2EE accounts (no metadata) and v1 leftovers (NULL signing key) revoke
 * without proof — the backend skips verification for them.
 */
export const revokeDevice = async (httpClient: HttpClient, deviceId: string, proof?: ChallengeProof): Promise<void> => {
  await httpClient.post(`account/devices/${encodeURIComponent(deviceId)}/revoke`, {
    json: proof ? { proof } : {},
  })
}

/**
 * Bind a device row to an iroh P2P endpoint identity (node_id). Gated by a
 * 'node-id' challenge proof — only a trusted device holding the account
 * signing key may attest it.
 */
export const setDeviceNodeId = async (
  httpClient: HttpClient,
  deviceId: string,
  nodeId: string,
  proof: ChallengeProof,
): Promise<void> => {
  await httpClient.post(`devices/${encodeURIComponent(deviceId)}/node-id`, { json: { nodeId, proof } })
}
