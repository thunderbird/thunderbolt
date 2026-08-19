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
  UpgradeRequest,
  UpgradeResponse,
  WrappedKeyEntry,
  WrappedKeyResponse,
  WrappedKeysListResponse,
  EnvelopeTargetsResponse,
} from '@shared/e2ee-types'

// The authenticated HttpClient (`createAuthenticatedClient`) already attaches
// `X-App-Version` (via `appVersionHeader`), the bearer token, and the device
// identity headers to every app-backend request, so these functions never add
// them per-call — they just take the client the caller already holds.

// =============================================================================
// Response types (matching backend)
// =============================================================================

export type RegisterDeviceResponse =
  | { trusted: true; envelope: string | null }
  /** `pendingSince` identifies this registration for a scoped cancel. Optional —
   *  a backend predating the scoped cancel simply omits it. */
  | { trusted: false; pendingSince?: string }

type StoreEnvelopeResponse = { trusted: true }

/** GET /devices/me/envelope — `wrappedCK` carries the AK in v2 (name kept for wire compat). */
type FetchEnvelopeResponse = { trusted: boolean; wrappedCK: string }

// =============================================================================
// Device registration + envelopes
// =============================================================================

/**
 * Token identifying this device's CURRENT pending registration, echoed back on
 * cancel so the server can reject a superseded one.
 *
 * Module-level because it is a per-device singleton by nature (like the device
 * id): exactly one producer (`registerDevice`) and one consumer
 * (`cancelPending`). Keeping it here rather than threading it through wizard
 * state means no cancel path can forget to scope itself.
 */
let currentPendingSince: string | undefined

/** Register (or re-identify) this device with the server. */
export const registerDevice = async (
  httpClient: HttpClient,
  params: { deviceId: string; publicKey: string; mlkemPublicKey: string; name?: string },
): Promise<RegisterDeviceResponse> => {
  const response = await httpClient.post('devices', { json: params }).json<RegisterDeviceResponse>()
  currentPendingSince = response.trusted ? undefined : response.pendingSince
  return response
}

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
  // Reads the token at CALL time, so the body carries the registration being
  // cancelled. Callers fire this without awaiting (the modal closes at once); if
  // the user re-registers before it lands, the server sees a stale token and
  // leaves the newer request alone instead of wiping the user's retry.
  await httpClient.post('devices/me/cancel-pending', { json: { pendingSince: currentPendingSince } })
}

// =============================================================================
// Encryption metadata + wrapped-DEK keyring
// =============================================================================

/**
 * Fetch the encryption metadata (canary, kdf_salt, signing key, key_version,
 * primary_key_id, scheme_version). 404 = encryption not set up. Rides the poll
 * clients already do at unlock — `key_version`/`scheme_version` detect rotations
 * and the v1→v2 flip. `signing_public_key`/`kdf_salt` are null for a pre-flip v1
 * account (scheme_version === 1).
 */
export const fetchEncryptionMetadata = async (httpClient: HttpClient): Promise<EncryptionMetadataResponse> =>
  httpClient.get('encryption/canary').json<EncryptionMetadataResponse>()

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
 * The devices an AK rotation / upgrade must cover, with the public keys needed to
 * wrap for each. Server-authoritative on purpose: it is the same predicate the
 * coverage validator uses, so the two can never disagree the way a
 * PowerSync-synced local read could.
 */
export const fetchEnvelopeTargets = async (httpClient: HttpClient): Promise<EnvelopeTargetsResponse> =>
  httpClient.get('encryption/envelope-targets').json<EnvelopeTargetsResponse>()

/**
 * Mint a NEW key_id on the server-side keyring (DEK rotation / workspace DEK).
 * Trusted device only; idempotent per key_id — never overwrites.
 */
export const postWrappedKey = async (
  httpClient: HttpClient,
  params: { keyId: KeyId; wrappedKey: string; setPrimary?: boolean; proof: ChallengeProof },
): Promise<{ key_id: KeyId }> => httpClient.post('encryption/keys', { json: params }).json<{ key_id: KeyId }>()

// =============================================================================
// Challenge-response + rotation + upgrade
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
 * v1→v2 migration (WS1): the migrator absorbs the legacy CK as the `"v1"` slot,
 * mints a fresh primary DEK `"0"`, registers the signing key + kdf_salt, writes
 * a new-AK envelope for every trusted device, and CAS-flips scheme_version 1→2
 * atomically. Gated by the D1 CK-possession proof (not a signature). A second
 * concurrent migrator loses the CAS and receives HTTP 409.
 */
export const postUpgrade = async (httpClient: HttpClient, body: UpgradeRequest): Promise<UpgradeResponse> =>
  httpClient.post('encryption/upgrade', { json: body }).json<UpgradeResponse>()

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
 * Bind a device row to an iroh P2P endpoint identity (node_id). Attesting
 * another device's P2P identity is a trusted-device admin action gated with the
 * 'approve' operation (challengeOperations has no dedicated 'node-id' op).
 */
export const setDeviceNodeId = async (
  httpClient: HttpClient,
  deviceId: string,
  nodeId: string,
  proof: ChallengeProof,
): Promise<void> => {
  await httpClient.post(`devices/${encodeURIComponent(deviceId)}/node-id`, { json: { nodeId, proof } })
}
