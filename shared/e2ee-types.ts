/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * E2EE v2 shared contracts — the single source of truth for every byte-level
 * contract that crosses the frontend/backend boundary (see the implementation
 * plan, docs/architecture/e2ee-v2-implementation-plan.md, SF1).
 *
 * Imported by BOTH the frontend (`@shared/e2ee-types`) and the backend
 * (`@shared/e2ee-types`, wired into backend/tsconfig.json `include`). Keep this
 * file runtime-agnostic: only TextEncoder + plain types, no WebCrypto, no DOM,
 * no Bun APIs.
 *
 * Spec: https://github.com/thunderbird/thunderbolt-spec/blob/spec/e2ee-v2/specs/e2ee-v2.md
 */

// =============================================================================
// Wire format — __enc:v2:<key_id>:<iv-base64>:<ct-base64>
// =============================================================================

/** Prefix shared by every encrypted value (v1 and v2). Detection only — never trust beyond parsing. */
export const encPrefix = '__enc:'

/** Version tag for the v2 wire format. Codec dispatches on this segment. */
export const wireVersionV2 = 'v2'

/** Full prefix of a v2 encrypted value. */
export const encV2Prefix = `${encPrefix}${wireVersionV2}:`

/**
 * Identifies one DEK version in the keyring: "0", "1", … (workspace DEKs get
 * ids like "ws1"). MUST never contain ':' — it is a wire-format segment.
 */
export type KeyId = string

/** The key_id minted at first-device setup and the default primary. */
export const initialKeyId: KeyId = '0'

/** One wrapped DEK as stored server-side and staged into IndexedDB for the worker. */
export type WrappedKeyEntry = {
  keyId: KeyId
  /** Base64 AES-KW(DEK) under the current AK. */
  wrappedKey: string
}

// =============================================================================
// AAD — table ‖ column ‖ row_id ‖ key_id (never stored on the wire)
// =============================================================================

/**
 * Row context threaded into encode/decode so AAD can be (re)built.
 * `table`/`column` are snake_case DB names (they must match
 * `encryptedColumnsMap` and the OplogEntry's `object_type`).
 */
export type EncryptionContext = {
  table: string
  column: string
  rowId: string
}

/**
 * Codec contract shared by the upload encoder (main thread) and the sync
 * middleware (SharedWorker). `ctx` is optional so v1 call sites typecheck
 * while C1/C2/D1 thread the context through; v2 encode/decode of configured
 * columns requires it (AAD).
 */
export type EncryptionCodec = {
  encode: (plaintext: string, ctx?: EncryptionContext) => Promise<string>
  decode: (encoded: string, ctx?: EncryptionContext) => Promise<string>
}

/**
 * Separator byte between AAD/challenge-payload segments. U+001F (unit
 * separator) cannot appear in table/column names, UUIDs, key_ids, base64
 * nonces, or device ids, so the encoding is unambiguous (no length prefixes
 * needed).
 */
export const payloadSeparator = '\u001f'

const utf8 = new TextEncoder()

/**
 * Canonical AAD byte layout bound to every v2 AES-GCM encrypt/decrypt:
 * UTF-8(`table ␟ column ␟ rowId ␟ keyId`). Both the upload encoder and the
 * sync-decode path MUST build AAD through this helper — never inline.
 */
export const encodeAAD = (table: string, column: string, rowId: string, keyId: KeyId): Uint8Array =>
  utf8.encode([table, column, rowId, keyId].join(payloadSeparator))

// =============================================================================
// Challenge-response — ECDSA P-256 over nonce ‖ operation ‖ device_id
// =============================================================================

/** Operations gated by a challenge proof. Stored on the nonce row and bound into the signature. */
export const challengeOperations = ['approve', 'deny', 'revoke', 'rotate', 'node-id'] as const

export type ChallengeOperation = (typeof challengeOperations)[number]

/**
 * Canonical challenge payload byte layout signed by the client (B4) and
 * verified by the backend (A2): UTF-8(`nonce ␟ operation ␟ deviceId`).
 * Both sides MUST use this helper — a divergent encoding fails silently.
 */
export const encodeChallengePayload = (nonce: string, operation: ChallengeOperation, deviceId: string): Uint8Array =>
  utf8.encode([nonce, operation, deviceId].join(payloadSeparator))

/** ECDSA key algorithm — used by importKey/generateKey on both sides. */
export const ecdsaKeyAlgorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const

/** ECDSA sign/verify algorithm — used by crypto.subtle.sign/verify on both sides. */
export const ecdsaSignAlgorithm = { name: 'ECDSA', hash: 'SHA-256' } as const

/** Export/import format for the signing PUBLIC key (base64-encoded for transport/storage). */
export const signingPublicKeyFormat = 'spki' as const

/** Challenge nonce TTL (~5 min) — enforced server-side, informational client-side. */
export const challengeNonceTtlMs = 5 * 60 * 1000

/** Issued by GET /v1/encryption/challenge (A4). */
export type ChallengeResponse = {
  nonce: string
  /** ISO-8601 expiry. */
  expires_at: string
}

/**
 * Proof-of-key-possession request body — replaces every v1 `canarySecret`
 * body field. `signature` is base64 ECDSA over `encodeChallengePayload(...)`.
 */
export type ChallengeProof = {
  signature: string
  nonce: string
  operation: ChallengeOperation
  deviceId: string
}

// =============================================================================
// KDF — recovery seed → AK (THU-414)
// =============================================================================

/** PBKDF2-SHA512 parameters for deriving the AK from the 24-word recovery seed. */
export const kdfAlgorithm = 'PBKDF2' as const
export const kdfHash = 'SHA-512' as const
export const kdfIterations = 600_000
/** Random per-account salt length in bytes; stored server-side as `kdf_salt` (base64). */
export const kdfSaltLength = 32

// =============================================================================
// API DTOs (snake_case field names are authoritative)
// =============================================================================

/**
 * GET /v1/encryption/canary — extended v2 metadata response. Piggybacks
 * `key_version`/`primary_key_id` polling on the fetch clients already do at
 * unlock (decision 3 in the plan).
 */
export type EncryptionMetadataResponse = {
  canary_iv: string
  canary_ctext: string
  /** Base64 random salt for the recovery-seed KDF. */
  kdf_salt: string
  /** Base64 SPKI ECDSA P-256 public key for challenge-response verification. */
  signing_public_key: string
  /** Bumped on every AK rotation — a bump tells devices to refresh their AK envelope. */
  key_version: number
  /** The key_id all new writes must encrypt under. */
  primary_key_id: KeyId
}

/** One row of GET /v1/encryption/keys[/:keyId] (A3). */
export type WrappedKeyResponse = {
  key_id: KeyId
  wrapped_key: string
}

/** GET /v1/encryption/keys — the full keyring for staging (F1 `stageKeyring`). */
export type WrappedKeysListResponse = {
  keys: WrappedKeyResponse[]
}

/**
 * POST /v1/encryption/rotate request body (A5, atomic AK rotation).
 * Request bodies are camelCase (matching existing routes); responses use the
 * snake_case DTOs above.
 */
export type RotateRequest = {
  /** Challenge proof with operation 'rotate'. */
  proof: ChallengeProof
  /** The new AK wrapped per trusted device (`wrappedCK` historically named — it carries the AK). */
  envelopes: Array<{ deviceId: string; wrappedCK: string }>
  /** The FULL keyring re-wrapped under the new AK — every existing key_id, no exceptions. */
  wrappedKeys: WrappedKeyEntry[]
  canaryIv: string
  canaryCtext: string
  /** Base64 SPKI ECDSA P-256 public key derived from the NEW canary secret. */
  signingPublicKey: string
  /** Base64 random salt for the NEW recovery-seed KDF. */
  kdfSalt: string
}

/** POST /v1/encryption/rotate response. */
export type RotateResponse = {
  key_version: number
}
