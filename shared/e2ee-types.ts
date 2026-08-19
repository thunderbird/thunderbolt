/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * E2EE v2 shared contracts — the single source of truth for every byte-level
 * contract that crosses the frontend/backend boundary (Track 0 of the
 * consolidated plan, docs/architecture/e2ee-v2-plan.md).
 *
 * Imported by BOTH the frontend (`@shared/e2ee-types`) and the backend
 * (`@shared/e2ee-types`, wired into backend/tsconfig.json `include`). Keep this
 * file runtime-agnostic: only TextEncoder + plain types, no WebCrypto, no DOM,
 * no Bun APIs.
 *
 * Spec: https://github.com/thunderbird/thunderbolt-spec/blob/spec/e2ee-v2/specs/e2ee-v2.md
 */

// =============================================================================
// Wire format — v2: __enc:v2:<key_id>:<iv-base64>:<ct-base64>
//                v1 (legacy, read-only): __enc:<iv-base64>:<ct-base64>
// =============================================================================

/** Prefix shared by every encrypted value (v1 and v2). Detection only — never trust beyond parsing. */
export const encPrefix = '__enc:'

/** Version tag for the v2 wire format. Codec dispatches on this segment. */
export const wireVersionV2 = 'v2'

/** Full prefix of a v2 encrypted value. Absence of this after `encPrefix` classifies a value as legacy v1. */
export const encV2Prefix = `${encPrefix}${wireVersionV2}:`

/**
 * Identifies one DEK version in the keyring: "0", "1", … (workspace DEKs get
 * ids like "ws1"). MUST never contain ':' — it is a wire-format segment.
 */
export type KeyId = string

/** The key_id minted at first-device setup and the default primary. */
export const initialKeyId: KeyId = '0'

/**
 * Reserved read-only slot holding the absorbed legacy v1 CK (dual-read model,
 * plan §2.3). A migrated account carries this alongside a real primary DEK; it
 * decrypts legacy `__enc:<iv>:<ct>` values (with NO AAD) and is NEVER used to
 * encrypt. Retained permanently — Decision (d).
 */
export const legacyKeyId: KeyId = 'v1'

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
 * middleware (SharedWorker). `ctx` is optional so the two existing one-arg call
 * sites (`upload-encoder.ts`, `EncryptionMiddleware.ts`) still typecheck when
 * Track 0 lands; v2 encode/decode of configured columns requires it (AAD).
 */
export type EncryptionCodec = {
  encode: (plaintext: string, ctx?: EncryptionContext) => Promise<string>
  decode: (encoded: string, ctx?: EncryptionContext) => Promise<string>
}

/**
 * Codec runtime-control surface — FROZEN NAMES (plan §3.4, finding S7).
 *
 * The v1 codec exported `invalidateCKCache`/`resetCodecState`, consumed by
 * `src/services/encryption.ts` (Track E). Track C's C1 replaces the single-CK
 * cache with a key_id-indexed cache; to keep the "communication only through
 * Track 0 contracts" invariant, the v2 names are frozen HERE and Track E imports
 * only these. Track C owns the bodies in `codec.ts` (these are frontend-only,
 * BroadcastChannel-backed, so they are NOT re-exported from this shared file):
 *   - `resetCodecState(): void`        — full cache clear (sign-out / account switch)
 *   - `invalidateKeyringCache(): void` — drop staged DEKs, keep the primary pointer
 */

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

/**
 * Canary AAD — Decision (c). The canary is a synthetic v2 value not tied to any
 * real table row, so it binds a FIXED tuple: table `__meta`, column `canary`,
 * rowId = the account's userId, and the primary DEK's keyId. Single source of
 * truth — `createCanary`/`verifyCanary` (Track B) MUST build canary AAD through
 * this helper, never inline, or verification silently fails across devices.
 */
export const canaryAAD = (userId: string, keyId: KeyId): Uint8Array => encodeAAD('__meta', 'canary', userId, keyId)

// =============================================================================
// Challenge-response — ECDSA P-256 over nonce ‖ operation ‖ device_id
// =============================================================================

/**
 * Operations gated by a challenge proof. Stored on the nonce row and bound into
 * the signature. `upgrade` is present only to type its replay nonce — it is the
 * BOOTSTRAP op and is NOT signature-verified (the signing key is null pre-flip);
 * `/upgrade` is gated solely by the D1 canary-possession proof (plan §2.4).
 */
export const challengeOperations = ['approve', 'deny', 'revoke', 'rotate', 'recover', 'upgrade'] as const

export type ChallengeOperation = (typeof challengeOperations)[number]

/**
 * Canonical challenge payload byte layout signed by the client and verified by
 * the backend: UTF-8(`nonce ␟ operation ␟ deviceId`). Both sides MUST use this
 * helper — a divergent encoding fails silently.
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

/** Issued by GET /v1/encryption/challenge. */
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
// Migration — scheme_version (plan §6.1, Decision D2)
// =============================================================================

/** Encryption scheme version for an account: 1 = legacy CK, 2 = AK/DEK keyring. */
export type SchemeVersion = 1 | 2

// =============================================================================
// API DTOs (snake_case field names are authoritative)
// =============================================================================

/**
 * GET /v1/encryption/canary — extended v2 metadata response. Piggybacks
 * `key_version`/`primary_key_id`/`scheme_version` polling on the fetch clients
 * already do at unlock (plan §2.4 transport).
 *
 * Nullable fields represent the pre-v2 (or not-yet-set-up) state: a v1 account
 * has a canary but no `signing_public_key`/`kdf_salt` until it upgrades; an
 * account with no encryption row at all has null canary fields.
 */
export type EncryptionMetadataResponse = {
  canary_iv: string | null
  canary_ctext: string | null
  /** Base64 random salt for the recovery-seed KDF (null pre-flip). */
  kdf_salt: string | null
  /** Base64 SPKI ECDSA P-256 public key for challenge-response verification (null pre-flip). */
  signing_public_key: string | null
  /** Bumped on every AK rotation — a bump tells devices to refresh their AK envelope. */
  key_version: number
  /** The key_id all new writes must encrypt under. */
  primary_key_id: KeyId
  /** 1 = legacy CK (upgrade eligible), 2 = migrated to the AK/DEK keyring. */
  scheme_version: SchemeVersion
}

/** One row of GET /v1/encryption/keys[/:keyId]. */
export type WrappedKeyResponse = {
  key_id: KeyId
  wrapped_key: string
}

/** GET /v1/encryption/keys — the full keyring for staging (`stageKeyring`). */
export type WrappedKeysListResponse = {
  keys: WrappedKeyResponse[]
}

/**
 * POST /v1/encryption/rotate request body (atomic AK rotation). Request bodies
 * are camelCase (matching existing routes); responses use the snake_case DTOs
 * above. The FULL keyring is re-wrapped under the new AK — every existing
 * key_id, including the `"v1"` slot when present (coverage validation, Risk 1).
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
  /**
   * The new AK wrapped for the org KMS escrow recipient (POC). REQUIRED
   * server-side when `ORG_KMS_ESCROW_ENABLED=true` (400 if missing), ignored and
   * never persisted when disabled.
   */
  orgEnvelope?: string
}

/** POST /v1/encryption/rotate response. */
export type RotateResponse = {
  key_version: number
}

/**
 * POST /v1/encryption/upgrade request body (v1→v2 migration, atomic CAS
 * scheme_version 1→2). The migrator absorbs the legacy CK into the keyring as
 * the `"v1"` slot AND mints a fresh primary DEK `"0"` (finding B2), so
 * `wrappedKeys` MUST contain both. Gated by `possessionProof` (D1): the
 * `canarySecret` recovered by a v1-style CK decrypt of the stored canary (NO
 * AAD) — NOT a challenge signature (the signing key does not exist pre-flip).
 */
export type UpgradeRequest = {
  /** Replay nonce with operation 'upgrade' (bootstrap op — not signature-verified). */
  nonce: string
  /** D1 CK-possession proof: the canarySecret recovered by CK-decrypting canary_ctext (no AAD). */
  possessionProof: string
  /** The new AK wrapped per trusted device. */
  envelopes: Array<{ deviceId: string; wrappedCK: string }>
  /** The new keyring: MUST include a fresh primary DEK "0" AND the absorbed "v1" slot. */
  wrappedKeys: WrappedKeyEntry[]
  /** The new primary — "0" for a freshly migrated account. */
  primaryKeyId: KeyId
  /** Canary re-encrypted under the new primary DEK (v2, with canaryAAD). */
  canaryIv: string
  canaryCtext: string
  /** Base64 SPKI ECDSA P-256 public key derived from the new canary secret. */
  signingPublicKey: string
  /** Base64 random salt for the new recovery-seed KDF. */
  kdfSalt: string
  /**
   * The new AK wrapped for the org KMS escrow recipient (POC). REQUIRED
   * server-side when `ORG_KMS_ESCROW_ENABLED=true` (400 if missing), ignored and
   * never persisted when disabled.
   */
  orgEnvelope?: string
}

/** POST /v1/encryption/upgrade response. */
export type UpgradeResponse = {
  key_version: number
  scheme_version: SchemeVersion
}

// =============================================================================
// Enterprise KMS key escrow (POC)
// docs/architecture/e2e-encryption.md#enterprise-kms-escrow-poc
// =============================================================================

/** Uncompressed P-256 point: 0x04 || X (32) || Y (32). Shared by both envelope formats and the settings validator. */
export const p256PointLength = 65

/** Leading byte of an uncompressed EC point, i.e. an envelope's second byte. */
export const uncompressedPointPrefix = 0x04

/** AES-KW of a 256-bit key: 32 bytes + an 8-byte integrity check. */
export const aesKwWrappedKeyLength = 40

/**
 * Org escrow envelope byte layout, frozen:
 *   [version 1B][ephemeral ECDH-P256 pubkey raw 65B][AES-KW-wrapped AK 40B]
 * The wrapper (`wrapAKForOrg`), the server-side shape check, and the operator
 * decrypt tool all derive their offsets from these — never re-declare them.
 * Independent of the hybrid device envelope's own `0x01` version space: the two
 * live in different columns and are never cross-parsed.
 */
export const orgEnvelopeVersion = 0x01
export const orgEnvelopeLength = 1 + p256PointLength + aesKwWrappedKeyLength

/**
 * HKDF `info` for the org escrow wrapping key. Distinct from the hybrid device
 * envelope's info string so the two derivations can never collide.
 */
export const orgKmsHkdfInfo = new TextEncoder().encode('thunderbolt-org-kms-ak-wrap-v1')

/** GET /v1/encryption/org-key response. Null fields mean escrow is disabled. */
export type OrgPublicKeyResponse = {
  enabled: boolean
  /** Base64 raw uncompressed P-256 point (65 bytes), null when disabled. */
  publicKey: string | null
  /** base64(SHA-256(raw public key bytes)), null when disabled. */
  fingerprint: string | null
}
