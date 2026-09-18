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
  DecryptionError,
  decrypt,
  encrypt,
  storeKeyPair,
  getKeyPair,
  openBindNonce,
  storeAK,
  getAK,
  storeDEK,
  getDEK,
  getLegacyCK,
  stageWrappedDEKs,
  pruneStagedDEKs,
  storePrimaryKeyId,
  getPrimaryKeyId,
  storeKeyVersion,
  type OpenedAkEnvelope,
  storeKeyringAnchor,
  getKeyringAnchor,
  mintKeyringAnchor,
  keyringAnchorOpens,
  anchorVersion,
  clearAllKeys,
  ValidationError,
  type StoredKeyPair,
} from '@/crypto'
import { getAuthToken, getDeviceId } from '@/lib/auth-token'
import { markRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
import { getDeviceDisplayName } from '@/lib/platform'
import { getCachedSession } from '@/lib/session-cache'
import { pinnedOrgEscrowPublicKey } from '@/lib/org-escrow'
import {
  bindSession,
  fetchBindChallenge,
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  fetchEncryptionMetadata,
  fetchWrappedKeys,
  fetchWrappedKey,
  fetchEnvelopeTargets,
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
  isMintableKeyId,
  legacyKeyId,
  type ChallengeOperation,
  type ChallengeProof,
  type KeyId,
  type RecoverySlotRequest,
  type WrappedKeyEntry,
} from '@shared/e2ee-types'

/**
 * The canary/signing and recovery-key modules carry ~44 KB (minified) of
 * @noble P-256/BIP-39 code that only these user-initiated flows need, so they
 * load lazily to stay out of the entry bundle (see src/crypto/index.ts).
 * Every caller is already network-bound, so the one-time chunk fetch is free.
 */
const loadCanary = () => import('@/crypto/canary')
const loadRecoveryKey = () => import('@/crypto/recovery-key')

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when POST /encryption/rotate rejects the payload (4xx) — the local
 * view of the keyring/devices/signing key was stale. Local state has already
 * been refreshed (`refreshAK`); the caller should simply retry the rotation.
 */
/**
 * Thrown when POST /encryption/rotate refuses a recovery re-anchor without a
 * valid step-up code (THU-875). NOT staleness — local state is fine and nothing
 * is refreshed; the caller re-prompts for the emailed code.
 * `step_up_required`: no code accompanied the request. `step_up_invalid`: the
 * code was wrong, expired, or burned its attempt budget.
 */
export class StepUpVerificationError extends Error {
  code: 'step_up_required' | 'step_up_invalid'
  constructor(code: 'step_up_required' | 'step_up_invalid', options?: ErrorOptions) {
    super(`Recovery re-anchor refused: ${code}`, options)
    this.name = 'StepUpVerificationError'
    this.code = code
  }
}

export class RotationStaleError extends Error {
  constructor(options?: ErrorOptions) {
    super('Key rotation state was stale — state refreshed, retry the rotation', options)
    this.name = 'RotationStaleError'
  }
}

/**
 * Thrown when this device's key material is too stale to derive the current
 * signing key (the served canary does not open under the local AK) on a path
 * that DELIBERATELY does not refresh — device revocation (THU-872). Refreshing
 * adopts server-supplied key material, and an emergency cut must not depend on
 * a fallible, attacker-influenced adoption running silently inside it: the UI
 * surfaces an explicit "refresh keys, then retry" step instead.
 */
export class StaleKeyMaterialError extends Error {
  constructor(options?: ErrorOptions) {
    super("This device's encryption keys are out of date — refresh keys and retry", options)
    this.name = 'StaleKeyMaterialError'
  }
}

/**
 * Thrown when a device revocation cut server access but the AK rotation that
 * locks the device out did not land (THU-887). The `cause` is the underlying
 * rotation failure.
 *
 * Its whole job is to record WHICH SIDE of the cut the failure happened on. The
 * original defect was a UI that could not tell the difference and therefore said
 * nothing; a message that hedges every outcome would be barely better. Because
 * this type exists, a pre-cut failure can honestly say "nothing was changed" and
 * a post-cut one can say "access was cut, your keys were not rotated" — see
 * `describeRevokeFailure`.
 *
 * Recoverable, and not by retrying the revoke: the device is already revoked, so
 * the outstanding work is the rotation alone (`finishDeviceLockout`). The server
 * reports the account's outstanding rotations via `fetchLockoutPending`, so this
 * error is the prompt, never the record.
 */
export class LockoutIncompleteError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'The device lost access, but the account key was not rotated, so the device still holds a usable key.',
      options,
    )
    this.name = 'LockoutIncompleteError'
  }
}

/**
 * Thrown when the recovery anchor served for a phrase-preserving re-anchor
 * carries no attestation, or one that does not verify under this device's own
 * key material (THU-865). Deliberately NOT retryable: retrying re-reads the
 * same untrusted anchor. Either the server is substituting recovery keys to
 * capture the next AK, or the account predates the attestation column — in
 * which case one explicit recovery-phrase change re-anchors it legitimately.
 */
export class RecoveryAnchorError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'The recovery keys the server supplied could not be verified against this device — ' +
        'refusing to re-anchor the account key. This may indicate tampering.',
      options,
    )
    this.name = 'RecoveryAnchorError'
  }
}

/**
 * Why an inbound Account Key was refused. Reported verbatim in telemetry —
 * these are SYMPTOMS, not diagnoses, because the two underlying causes are not
 * distinguishable from the client:
 *
 * - `unopenable` — the candidate AK does not open the served DEK `"0"` row.
 *   Either the server paired a forged envelope with an honest keyring, or the
 *   envelope and the keyring were read either side of a concurrent rotation.
 * - `material-mismatch` — the candidate DOES open the row, but the key material
 *   inside is not what this device witnessed. Either the server minted a
 *   matching AK'/DEK-0' pair of its own, or DEK `"0"`'s material genuinely
 *   changed — which v2 never does legitimately (see the invariant note on
 *   `assertRotateKeyCoverage` and on `dbVersion` in `src/crypto/key-storage.ts`).
 * - `no-witness` — an established device (it holds an AK) has neither an anchor
 *   nor a local DEK `"0"` to mint one from. Unreachable honestly; it is what a
 *   server withholding `key_id "0"` produces, and refusing is what stops that
 *   from being a silent bypass.
 */
export type AKRefusalReason = 'unopenable' | 'material-mismatch' | 'no-witness'

/**
 * Thrown when a server-supplied Account Key cannot be tied back to this
 * device's local witness of DEK `"0"` (THU-869). The AK envelope is anonymous —
 * `wrapAK` needs only public keys the server itself stores — so a well-formed
 * envelope proves nothing about who minted the key inside it.
 *
 * Deliberately NOT retryable the way `RotationStaleError` is: retrying re-reads
 * the same untrusted envelope. Nothing is persisted, so the device keeps the
 * keys it already had, keeps working, and recovers by itself the moment an
 * openable envelope is served.
 */
export class AKAnchorError extends Error {
  readonly reason: AKRefusalReason

  constructor(reason: AKRefusalReason, options?: ErrorOptions) {
    super(
      `Refusing the account key the server supplied (${reason}) — it does not match this device's ` +
        `witness of DEK '${initialKeyId}'. This may indicate tampering.`,
      options,
    )
    this.name = 'AKAnchorError'
    this.reason = reason
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

/**
 * Recover the canary key from local key material: AK → unwrap the served canary
 * (THU-872 — the canary is anchored to the ACCOUNT KEY, so only a device holding
 * the current AK can open it; a revoked device's retained DEK "0" derives
 * nothing). The seed never surfaces to script; the returned handle feeds the
 * deterministic ECDSA signing keypair used for challenge proofs.
 *
 * Throws `DecryptionError` when the canary does not open under the local AK —
 * the signature of a stale AK after a rotation elsewhere.
 */
const readCanaryKey = async (httpClient: HttpClient): Promise<CryptoKey> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  if (!metadata.canary_iv || !metadata.canary_ctext) {
    throw new Error('Canary is not set up on the server')
  }
  const ak = await getAK()
  if (!ak) {
    throw new Error('Account key not found in IndexedDB')
  }
  const { unwrapCanaryKey } = await loadCanary()
  return unwrapCanaryKey(ak, getUserId(), metadata.canary_iv, metadata.canary_ctext)
}

/**
 * `readCanaryKey` with the stale-AK self-heal: on a canary that does not open,
 * refresh this device's AK (witness-gated, `refreshAK`) and retry ONCE.
 * `refresh: false` is the device-revocation variant (THU-872): the emergency
 * cut must not have a server-driven key adoption running silently inside it,
 * so it surfaces `StaleKeyMaterialError` for an EXPLICIT refresh-then-retry
 * step instead.
 */
const getCanaryKey = async (httpClient: HttpClient, opts: { refresh?: boolean } = {}): Promise<CryptoKey> => {
  try {
    return await readCanaryKey(httpClient)
  } catch (err) {
    if (!(err instanceof DecryptionError)) {
      throw err
    }
    if (opts.refresh === false) {
      throw new StaleKeyMaterialError({ cause: err })
    }
    await refreshAK(httpClient)
    return readCanaryKey(httpClient)
  }
}

/**
 * Build a ChallengeProof for a trust-sensitive operation: fetch a single-use
 * nonce and sign `nonce ‖ operation ‖ deviceId` with the signing key derived
 * from the canary key. Pass `canaryKey` when it is already in hand (recovery);
 * otherwise it is recovered from local key material.
 */
const buildProof = async (
  httpClient: HttpClient,
  operation: ChallengeOperation,
  canaryKey?: CryptoKey,
): Promise<ChallengeProof> => {
  const key = canaryKey ?? (await getCanaryKey(httpClient))
  const { nonce } = await fetchChallenge(httpClient, operation)
  const deviceId = getDeviceId()
  const { signChallenge } = await loadCanary()
  const signature = await signChallenge(key, nonce, operation, deviceId)
  return { signature, nonce, operation, deviceId }
}

/**
 * Wrap `ak` to the operator escrow public key (THU-804), if this BUILD pins one.
 * Returns `undefined` otherwise — callers spread it into request bodies, where
 * `JSON.stringify` simply omits the field.
 *
 * The pin is the whole trust root (THU-866, C11). No server response is consulted
 * here — not a key, not an enabled flag — which is what makes escrow unsteerable:
 * a lying server can neither redirect the AK to a key it holds nor suppress the
 * operator's copy. A build with no pin escrows nothing, no matter what the server
 * claims. The server keeps only `ORG_ESCROW_ENABLED`, to make the envelope
 * mandatory.
 *
 * Always call this with the NEW AK of the flow (the same key being wrapped into
 * the device envelopes) — never the old one.
 */
export const buildOrgEnvelope = async (ak: CryptoKey): Promise<string | undefined> => {
  const pinnedPublicKey = pinnedOrgEscrowPublicKey()
  if (!pinnedPublicKey) {
    return undefined
  }
  return wrapAKForOrg(ak, await importOrgPublicKey(pinnedPublicKey))
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
 *
 * `canaryKey` must be the one belonging to the SAME write — the newly minted
 * canary on a rotation/upgrade, or the just-created one at first-device setup.
 * Signing the anchor with it (THU-865) is what lets the next rotating device
 * verify these public keys instead of trusting whatever the server serves.
 */
const buildRecoverySlot = async (
  ak: CryptoKey,
  recovery: RecoveryPublicKeys,
  kdfSalt: string,
  canaryKey: CryptoKey,
  primaryKeyId: KeyId,
): Promise<RecoverySlotRequest> => {
  const recoveryEcdhPublicKey = await exportPublicKey(recovery.ecdhPublicKey)
  const recoveryMlkemPublicKey = exportMlKemPublicKey(recovery.mlkemPublicKey)
  const { signRecoveryAttestation } = await loadCanary()
  return {
    recoveryEcdhPublicKey,
    recoveryMlkemPublicKey,
    recoveryWrappedAK: await wrapAK(ak, recovery.ecdhPublicKey, recovery.mlkemPublicKey, primaryKeyId),
    recoveryAttestation: await signRecoveryAttestation(canaryKey, {
      userId: getUserId(),
      kdfSalt,
      recoveryEcdhPublicKey,
      recoveryMlkemPublicKey,
    }),
  }
}

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
  const { generateRecoverySeed, encodeRecoverySeed, generateKdfSalt, deriveRecoveryKeyPairFromSeed } =
    await loadRecoveryKey()
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
 *
 * THE SERVED ANCHOR IS NOT TRUSTED (THU-865). Wrapping the new AK needs only
 * public keys, so a malicious server that substitutes its own here would receive
 * the AK and could then recover the account with a phrase it chose — silently,
 * on any routine device revoke. The attestation closes that: it is verified
 * against a signing key derived from `canaryKey`, which the caller recovered
 * from its OWN key material (`getCanaryKey`), so only a keyring holder could
 * have produced it. Fail closed — never adopt an unverifiable anchor.
 */
const readStoredRecoveryPlan = async (httpClient: HttpClient, canaryKey: CryptoKey): Promise<RecoveryPlan> => {
  const metadata = await fetchEncryptionMetadata(httpClient)
  if (!metadata.kdf_salt || !metadata.recovery_ecdh_public_key || !metadata.recovery_mlkem_public_key) {
    throw new Error(
      'Account has no recovery slot — the account key cannot be rotated without changing the recovery phrase',
    )
  }
  const anchor = {
    userId: getUserId(),
    kdfSalt: metadata.kdf_salt,
    recoveryEcdhPublicKey: metadata.recovery_ecdh_public_key,
    recoveryMlkemPublicKey: metadata.recovery_mlkem_public_key,
  }
  const { verifyRecoveryAttestation } = await loadCanary()
  if (
    !metadata.recovery_attestation ||
    !(await verifyRecoveryAttestation(canaryKey, metadata.recovery_attestation, anchor))
  ) {
    throw new RecoveryAnchorError()
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
// Device–session binding (THU-873)
// =============================================================================

/** Bearer token of the last successfully bound session — dedupes repeat calls. */
let lastBoundToken: string | null = null

/**
 * Prove to the backend that this session belongs to THIS device, so every trust
 * route can resolve its caller from `session.deviceId` instead of the
 * client-set `X-Device-ID` header.
 *
 * Needed because a session is linked at first registration only: when a session
 * expires, the client keeps its keys and device id and re-authenticates, and
 * that new session is bound to nothing. Without this it would be refused by
 * every keyring, challenge and rotation route.
 *
 * The server seals a nonce to this device's registered ECDH public key; opening
 * it requires the non-extractable private key in IndexedDB, which is exactly
 * the thing no other session — and no revoked device — can supply for us.
 *
 * No-ops when this device holds no key pair: it has never registered, so there
 * is nothing to bind and registration will link the session anyway.
 */
export const ensureSessionBound = async (httpClient: HttpClient): Promise<void> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    return
  }
  // One handshake per credential. Keyed on the bearer because that IS the
  // session: a re-authentication produces a new token and therefore a new,
  // unbound session, which must be bound again.
  const token = getAuthToken()
  if (token && token === lastBoundToken) {
    return
  }
  const { sealed } = await fetchBindChallenge(httpClient)
  const nonce = await openBindNonce(keyPair.ecdhPrivateKey, sealed)
  await bindSession(httpClient, { deviceId: getDeviceId(), nonce })
  lastBoundToken = token
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

/** Fetch the keyring and its pointers as one snapshot. */
const fetchKeyring = async (httpClient: HttpClient): Promise<FetchedKeyring> => {
  const [{ keys }, metadata] = await Promise.all([fetchWrappedKeys(httpClient), fetchEncryptionMetadata(httpClient)])
  return { keys, primaryKeyId: metadata.primary_key_id, keyVersion: metadata.key_version }
}

/**
 * DEK `"0"`'s wrapped blob as the SERVER just served it.
 *
 * Never resolve this from the LOCAL staged blob: after a rotation that copy is
 * still wrapped under the OLD AK, so unwrapping it under a candidate new AK
 * fails and every legitimate rotation would be refused. The check reads the
 * served row; the mint reads the local one. Opposite directions, same key_id —
 * keep them apart.
 */
const servedWrappedDek0 = (keyring: FetchedKeyring): string | null =>
  keyring.keys.find((key) => key.key_id === initialKeyId)?.wrapped_key ?? null

/** DEK `"0"` as derived from purely LOCAL state, or null when either half is absent. */
const localDek0 = async (): Promise<CryptoKey | null> => {
  const [ak, wrapped] = await Promise.all([getAK(), getDEK(initialKeyId)])
  if (!ak || !wrapped) {
    return null
  }
  return unwrapDEK(wrapped, ak, initialKeyId).catch(() => null)
}

/**
 * Create the local DEK `"0"` witness when this device has none, or replace it
 * when its on-disk format is superseded.
 *
 * MINTS FROM LOCAL STATE ONLY. Minting from a served keyring would hand the
 * adversary the check's own bypass: the skip condition is "no anchor", so a
 * server that simply omits `key_id "0"` from its keyring response guarantees no
 * device ever mints one and the guard never fires anywhere. That is how the
 * first draft of this fix managed to be a no-op.
 *
 * A CURRENT anchor is never rewritten — deliberately, and this is the subtle
 * part. "Re-mint whenever the anchor does not open under the local DEK `"0"`"
 * looks like a harmless self-heal and is not: when this was designed the DEK
 * wrapping (then AES-KW) carried no key_id binding, so a server could serve an
 * honest blob for a DIFFERENT key relabelled as `"0"`, it unwrapped fine, and a
 * re-mint would have quietly repointed the witness at a key the server chose.
 * `dekWrapAAD` (THU-893) now makes that relabel fail at unwrap, but write-once
 * stays: it is what makes the witness trustworthy independent of the wrapping
 * scheme, and DEK `"0"`'s material is immutable by invariant anyway.
 *
 * The cost of that choice is that a FOREIGN anchor — account A's, surviving on a
 * device now signed in as B because `clearLocalData` logs and continues when
 * `handleFullWipe` throws — wedges adoption until the next successful wipe.
 * Signing out again clears it, and the `device_id_taken` reset path already
 * does so incidentally.
 *
 * A version bump is therefore a deliberate trust-on-first-use moment: keep them
 * rare, and when a second format appears, verify the old anchor under the old
 * reader before replacing it rather than minting blind.
 */
const reconcileKeyringAnchor = async (): Promise<void> => {
  const anchor = await getKeyringAnchor()
  if (anchor?.version === anchorVersion) {
    return
  }
  const dek0 = await localDek0()
  if (!dek0) {
    return
  }
  await storeKeyringAnchor(await mintKeyringAnchor(dek0))
}

/**
 * Refuse a candidate AK unless it proves it belongs to this account.
 *
 * The proof: unwrap the SERVED DEK `"0"` row under the candidate, then open
 * this device's local witness with the result. DEK `"0"`'s material is
 * immutable for the life of a v2 account — bootstrap and the v1 upgrade mint it
 * once, and every AK rotation re-wraps the SAME key (`rewrapKeyring`) — so this
 * passes for a legitimately rotated AK and fails for one the server minted. That
 * immutability is the whole reason the witness is a ciphertext UNDER DEK `"0"`
 * rather than a copy of its wrapping: a wrapping legitimately changes on every
 * rotation, so it could never be written once.
 *
 * A device with no witness and no AK is genuinely new: its first AK is
 * trust-on-first-use and cannot be otherwise, because it shares no secret with
 * the account and the only channel is the adversary. A device with an AK but no
 * witness is not new — see `no-witness`.
 *
 * FAILS CLOSED, unlike `runContinuityCheck` below, which has the same shape and
 * skips-and-swallows. That one is defence-in-depth behind a server-side proof;
 * this one is the only thing between a malicious server and every future write.
 */
const assertCandidateAKIsOurs = async (candidate: CryptoKey, keyring: FetchedKeyring): Promise<void> => {
  const anchor = await getKeyringAnchor()
  if (!anchor) {
    if (await getAK()) {
      throw new AKAnchorError('no-witness')
    }
    return
  }

  const served = servedWrappedDek0(keyring)
  if (!served) {
    throw new AKAnchorError('unopenable')
  }
  const candidateDek0 = await unwrapDEK(served, candidate, initialKeyId).catch(() => null)
  if (!candidateDek0) {
    throw new AKAnchorError('unopenable')
  }
  if (!(await keyringAnchorOpens(anchor, candidateDek0))) {
    throw new AKAnchorError('material-mismatch')
  }
}

/**
 * The single place a server-supplied AK becomes this device's AK: verify it,
 * store it, and return the keyring that was verified WITH it.
 *
 * Returning the keyring is not a convenience — it is what lets callers persist
 * the exact snapshot that was checked. Re-fetching afterwards reopens the gap
 * the check exists to close (that was the follower-path defect, THU-869).
 *
 * Nothing is written on refusal: the device keeps the AK, keyring and pointer it
 * already had and carries on using them.
 */
const acceptCandidateAK = async (httpClient: HttpClient, candidate: CryptoKey): Promise<FetchedKeyring> => {
  await reconcileKeyringAnchor()
  const keyring = await fetchKeyring(httpClient)
  try {
    await assertCandidateAKIsOurs(candidate, keyring)
  } catch (err) {
    if (err instanceof AKAnchorError) {
      console.error(`[e2ee] refused an inbound account key (${err.reason}) — keeping the keys already in force`)
      trackError(createHandleError('AK_ANCHOR_REFUSED', `Refused an inbound account key: ${err.reason}`, err))
    }
    throw err
  }
  await storeAK(candidate)
  return keyring
}

/** Unwrap an AK envelope with this device's transport keys — key + sealed pointer. */
const unwrapEnvelopeAK = async (wrappedCK: string): Promise<OpenedAkEnvelope> => {
  const keyPair = await getKeyPair()
  if (!keyPair) {
    throw new Error('Key pair not found in IndexedDB')
  }
  return unwrapAK(wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey)
}

/**
 * Re-fetch this device's envelope and adopt the AK it carries, subject to the
 * DEK `"0"` witness check. Returns the verified keyring plus the pointer sealed
 * into the envelope — the pointer's ONLY trusted source (THU-890): it shares
 * the AK's auth tag, so the server cannot pair the account's real current AK
 * with a pointer of its choosing.
 *
 * A 404 propagates: for `refreshAK` a missing envelope means this device was
 * revoked, which must surface rather than look like a no-op. The one caller that
 * reads 404 as "not approved yet" narrows that catch itself.
 */
const adoptEnvelopeAK = async (httpClient: HttpClient): Promise<{ keyring: FetchedKeyring; primaryKeyId: KeyId }> => {
  const { wrappedCK } = await fetchMyEnvelope(httpClient)
  const envelope = await unwrapEnvelopeAK(wrappedCK)
  const keyring = await acceptCandidateAK(httpClient, envelope.ak)
  return { keyring, primaryKeyId: envelope.primaryKeyId }
}

/**
 * Does the locally stored AK still open the keyring the server just handed us?
 *
 * A CURRENCY probe, NOT a security check — `false` only means the AK was
 * rotated elsewhere and this device has not caught up. It cannot authenticate
 * anything: on the `refreshAK` path the stored AK has already been replaced by
 * the time it would run, and its outcome is attacker-chosen anyway, since
 * failing it is what TRIGGERS an adoption. Possession lives in
 * `assertCandidateAKIsOurs`. This function being mislabelled as a guard is how
 * `refreshAK` came to look protected while adopting unconditionally (THU-869).
 *
 * No local AK (first setup, mid-recovery) is not a contradiction — there is
 * nothing to be stale.
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
  return unwrapDEK(probe.wrapped_key, ak, probe.key_id).then(
    () => true,
    () => false,
  )
}

/**
 * @param adoptedPrimaryKeyId - the pointer sealed into a JUST-ADOPTED AK
 *   envelope, when this apply follows an adoption. The served
 *   `metadata.primary_key_id` is NEVER stored (THU-890) — it is advisory: a
 *   grammar-valid rollback (`"0"` served after a rotation moved the primary to
 *   `"1"`) would re-open every key a revoked device copied. On the fast path
 *   (the stored AK still opens the keyring — same epoch) the pointer cannot
 *   have moved, so it is deliberately left alone.
 */
const applyKeyring = async (keyring: FetchedKeyring, adoptedPrimaryKeyId?: KeyId): Promise<void> => {
  // Witness DEK "0" BEFORE the staging below, so an established device mints
  // from the blob it already held rather than the one now arriving.
  await reconcileKeyringAnchor()
  await stageWrappedDEKs(keyring.keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key })))
  // Mirror the server's keyring rather than accumulating a superset of it: a
  // key_id that is gone server-side would otherwise keep a stale wrapped blob
  // here forever, which resolves to a permanent `unwrap-failed` (THU-871).
  await pruneStagedDEKs(keyring.keys.map((key) => key.key_id))
  // A non-mintable id is a steer — most sharply onto the decrypt-only `"v1"`
  // slot (THU-876) — even when it arrives sealed by an honest writer's bug.
  // Refuse it and keep the primary already in force, rather than rejecting the
  // whole keyring: the DEKs above are legitimate and needed for reads, so
  // failing here would turn a steer into a read outage.
  if (adoptedPrimaryKeyId !== undefined) {
    if (isMintableKeyId(adoptedPrimaryKeyId)) {
      await storePrimaryKeyId(adoptedPrimaryKeyId)
    } else {
      console.error(`[e2ee] refused a non-mintable primary key_id from the adopted envelope: '${adoptedPrimaryKeyId}'`)
    }
  }
  await storeKeyVersion(keyring.keyVersion)
  // Again, for a device being ESTABLISHED: before the staging above it had no
  // local DEK "0" to witness, so the call at the top could not mint. Idempotent
  // — a device that already minted one hits the version check and returns.
  //
  // Minting here reads a blob that arrived in this very response, which is why
  // it is second rather than first. That is not a weakness added by ordering: a
  // device's FIRST witness is trust-on-first-use whatever it is derived from,
  // since a new device shares no secret with the account and an existing one
  // holds only blobs the server previously served. See the residuals in
  // `.red-team/thu-869-plan.md`.
  await reconcileKeyringAnchor()
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
  const keyring = await fetchKeyring(httpClient)
  // The fast path also requires a local pointer: the pointer's only trusted
  // source is the AK envelope (THU-890), so a device that somehow lost its
  // pointer alone must re-adopt to restore it — never take the metadata value.
  if ((await getPrimaryKeyId()) !== null && (await keyringUnwrapsUnderLocalAK(keyring))) {
    await applyKeyring(keyring)
    return
  }
  // Behind a rotation (or missing its pointer). Adopt, and apply the keyring
  // the adoption VERIFIED — not the one fetched above, which was never tied to
  // the new AK — with the pointer the envelope sealed.
  const adopted = await adoptEnvelopeAK(httpClient)
  await applyKeyring(adopted.keyring, adopted.primaryKeyId)
}

/**
 * Refresh this device's AK after a rotation (key_version bump or DEK-unwrap
 * failure): re-fetch the replaced envelope, verify the AK it carries against
 * this device's DEK `"0"` witness, store it, and persist the keyring that was
 * verified with it. Without this, no remaining device can read
 * post-revocation data.
 *
 * Previously this called `stageKeyring`, which adopted a SECOND time from a
 * separately-fetched keyring — two unverified adoptions per refresh, and the
 * inner one is what made the currency probe look like a guard (THU-869).
 *
 * Track F wires the responder's zero-arg `refreshAK: () => Promise<void>` with
 * `() => refreshAK(client)`.
 */
export const refreshAK = async (httpClient: HttpClient): Promise<void> => {
  const adopted = await adoptEnvelopeAK(httpClient)
  await applyKeyring(adopted.keyring, adopted.primaryKeyId)
}

/**
 * `refreshAK` for the rotation paths, tolerant of one torn read.
 *
 * The envelope and the keyring are two requests. A rotation landing between
 * them yields an envelope from one epoch and a keyring from the next, so the
 * candidate AK cannot open the served DEK `"0"` and the witness check refuses —
 * on a perfectly honest server. Both rotation callers run exactly when that is
 * likely (one of them IS the "another device rotated first" branch) and both are
 * user-facing, so the retry is the difference between "please try again" and
 * telling someone their server may be tampering with their account.
 *
 * Only `unopenable` is retried. `material-mismatch` and `no-witness` are not
 * timing artefacts — re-reading cannot change them, and they must surface.
 */
const refreshAKForRotation = async (httpClient: HttpClient): Promise<void> => {
  try {
    await refreshAK(httpClient)
  } catch (err) {
    if (err instanceof AKAnchorError && err.reason === 'unopenable') {
      await refreshAK(httpClient)
      return
    }
    throw err
  }
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

  const { wrappedKey } = await mintDEK(extractableAK, initialKeyId)
  // Anchored to the AK, not DEK "0" (THU-872) — `canaryKey` is the unwrap of the
  // exact bytes being posted, so the published signing key is correct by
  // construction (the pre-submit round-trip check).
  const { mintCanary, deriveSigningKeyPair } = await loadCanary()
  const { canaryIv, canaryCtext, canaryKey } = await mintCanary(extractableAK, getUserId())
  const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)

  const wrappedCK = await wrapAK(extractableAK, keyPair.ecdhPublicKey, keyPair.mlkemPublicKey, initialKeyId)
  const recoverySlot = await buildRecoverySlot(
    extractableAK,
    recovery.publicKeys,
    recovery.kdfSalt,
    canaryKey,
    initialKeyId,
  )
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
    orgEnvelope: await buildOrgEnvelope(extractableAK),
  })

  // AK stored LAST so its presence always implies a complete local keyring.
  await storeDEK(initialKeyId, wrappedKey)
  await storePrimaryKeyId(initialKeyId)
  await storeKeyVersion(1)
  await storeAK(ak)
  // Witness DEK "0" now, from an AK this device generated itself — the most
  // trustworthy moment that will ever exist on this account. Waiting for the
  // first `stageKeyring` would leave a window in which an adoption could be
  // driven before any witness exists.
  await reconcileKeyringAnchor()
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
const buildRevokeProof = async (httpClient: HttpClient, canaryKey?: CryptoKey): Promise<ChallengeProof | undefined> => {
  const metadata = await fetchEncryptionMetadata(httpClient).catch((err: unknown) => {
    if (err instanceof HttpError && err.response.status === 404) {
      return null
    }
    throw err
  })
  if (!metadata || metadata.signing_public_key == null) {
    return undefined
  }
  return buildProof(httpClient, 'revoke', canaryKey)
}

/**
 * Revoke a device with a 'revoke' challenge proof when E2EE v2 is active.
 * Falls back to no proof for pre-E2EE users and v1 leftovers. Note: this only
 * cuts server access — `revokeDeviceAndRotate` also locks the device out of
 * the keyring cryptographically.
 *
 * `canaryKey` is an optional pre-recovered canary key, passed by
 * `revokeDeviceAndRotate` so the whole revocation recovers it once instead of
 * once per step.
 */
export const revokeDeviceWithProof = async (
  httpClient: HttpClient,
  deviceId: string,
  canaryKey?: CryptoKey,
): Promise<void> => {
  const proof = await buildRevokeProof(httpClient, canaryKey).catch((err: unknown) => {
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
  // The 404 catch is scoped to the ENVELOPE fetch alone. A single try/catch
  // around the whole body would also read a 404 from the keyring or metadata
  // route as "this device is not approved yet" and poll forever.
  const envelope = await fetchMyEnvelope(httpClient).catch((err: unknown) => {
    if (err instanceof HttpError && err.response.status === 404) {
      return null
    }
    throw err
  })
  if (!envelope) {
    return false
  }

  const opened = await unwrapEnvelopeAK(envelope.wrappedCK)
  await applyKeyring(await acceptCandidateAK(httpClient, opened.ak), opened.primaryKeyId)
  return true
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
  const { decodeRecoveryKey, deriveRecoveryKeyPairFromSeed } = await loadRecoveryKey()
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

  const { ak, primaryKeyId: sealedPrimaryKeyId } = await unwrapAK(
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
  const dek0 = await unwrapDEK(wrappedDEK0, ak, initialKeyId).catch(() => null)
  if (!dek0) {
    throw new ValidationError('Invalid recovery key')
  }
  // The canary is wrapped under the CURRENT AK (THU-872), so a recovery slot
  // that no longer matches the live epoch fails to open it. DEK '0' is unwrapped
  // separately, ONLY for the keyring witness below — the two paths share no
  // variable.
  const { unwrapCanaryKey } = await loadCanary()
  const canaryKey = await unwrapCanaryKey(ak, getUserId(), metadata.canary_iv, metadata.canary_ctext).catch(() => null)
  if (!canaryKey) {
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
  const proof = await buildProof(httpClient, 'approve', canaryKey)
  await storeEnvelope(httpClient, { deviceId, wrappedCK, proof })

  // DELIBERATELY NOT gated by the DEK "0" witness check: the phrase is the
  // account's break-glass, and one the thing it rescues you from can disable is
  // not a break-glass. A device re-established from the phrase must be able to
  // come back.
  //
  // It re-mints the witness ONLY when this device held no AK — the fresh-device
  // and re-establishment case, where any surviving anchor is necessarily stale
  // (e.g. the previous account's, left behind because `clearLocalData` logs and
  // continues when `handleFullWipe` throws) and where trust-on-first-use applies
  // regardless. On a device that still HOLDS an AK, the witness is left alone:
  // the phrase does not authenticate the AK — `wrapAK` needs only the recovery
  // slot's PUBLIC halves, which the server stores, so a malicious server can
  // wrap an AK of its own to them and the phrase still opens it. Re-minting
  // there would turn "talk the user into a recovery" into a witness bypass.
  // An established device with a poisoned witness recovers by signing out, which
  // wipes the store outright.
  const hadLocalAK = (await getAK()) !== null
  await storeAK(ak)
  if (!hadLocalAK) {
    await storeKeyringAnchor(await mintKeyringAnchor(dek0))
  }
  // The pointer sealed into the recovery envelope is this device's only trusted
  // source for it (THU-890) — stored BEFORE `stageKeyring`, whose fast path
  // deliberately never writes a pointer.
  await storePrimaryKeyId(sealedPrimaryKeyId)
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

/**
 * Wrap `ak` into a device-envelope for each trusted device, honoring exclusions.
 * `primaryKeyId` is sealed into every envelope (THU-890) — the writer always
 * knows it locally (the minted id, or its own verified pointer), so no served
 * value is ever laundered into a seal.
 */
const buildDeviceEnvelopes = async (
  ak: CryptoKey,
  trustedDevices: TrustedDevicePublicKeys[],
  primaryKeyId: KeyId,
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
    envelopes.push({ deviceId: device.id, wrappedCK: await wrapAK(ak, ecdhPub, mlkemPub, primaryKeyId) })
  }
  return envelopes
}

/**
 * Allocate the key_id for a freshly minted primary DEK: the SMALLEST canonical
 * counter not already on the live keyring.
 *
 * Smallest-unused rather than highest-plus-one, and that choice is the fix
 * (THU-871). Highest-plus-one is what a planted row could weaponise:
 *
 * - Originally the max ran over every id `parseInt` accepted, so a row labelled
 *   with 17+ digits made `max + 1 === max` and the "new" id collided with the
 *   attacker's row. The server silently kept the attacker's wrapping while
 *   moving the primary onto it, bricking every future write on the account.
 * - Filtering to `keyIdPattern` fixed the collision but left the boundary: a
 *   planted `'9'.repeat(15)` is itself grammar-valid, so `max + 1` produced a
 *   16-digit id that the server's own mint validation then rejected — blocking
 *   every revocation instead, which is the freeze this ticket also fixes.
 *
 * Picking a hole closes both, because the result is by construction an id that
 * is not on the keyring and cannot leave the grammar: a keyring holding N
 * mintable ids must leave one of the N+1 candidates `0..N` free (pigeonhole), so
 * the id stays bounded by the keyring's own size no matter what was planted. On
 * a healthy account there are no holes — rows are never deleted, so the ids are
 * `0, 1, 2, …` and this is exactly highest-plus-one. A planted id only ever
 * becomes a gap to step over.
 *
 * Ids outside the grammar are ignored entirely; they cannot alias a candidate,
 * since candidates are canonical decimal strings.
 */
const nextPrimaryKeyId = (existingKeyIds: string[]): KeyId => {
  const taken = new Set(existingKeyIds.filter(isMintableKeyId))
  return Array.from({ length: taken.size + 1 }, (_, index) => String(index)).find((keyId) => !taken.has(keyId))!
}

export type RotateAKOptions = {
  /**
   * Devices that must NOT receive a new-AK envelope even if the synced
   * `devices` table still shows them trusted (sync lag after a revocation).
   */
  excludeDeviceIds?: string[]
  /**
   * Also mint a fresh primary DEK as part of this rotation (THU-871) — set by
   * device revocation, which needs BOTH rotations: a new DEK so future writes
   * use a key the removed device never held, and a new AK to lock it out of the
   * keyring. A phrase change leaves it unset and rotates the AK alone.
   */
  mintNewPrimary?: boolean
  /** Dependency seam for the synced-devices read (tests). */
  listTrustedDevices?: () => Promise<TrustedDevicePublicKeys[]>
  /**
   * Step-up verification code (THU-875) — required by the server when this
   * rotation re-anchors the recovery slot to NEW keys (a phrase change). Silent
   * rotations reuse the stored keys and never need one.
   */
  stepUpOtp?: string
}

/**
 * Resolves the recovery anchor for one rotation. Invoked AFTER the proof is
 * built, and handed the OLD epoch's canary key so a 'keep' re-anchor can
 * verify the served anchor's attestation against local key material (THU-865).
 * A 'new' anchor mints its own keys and ignores it.
 */
type ResolveRecoveryPlan = (canaryKey: CryptoKey) => Promise<RecoveryPlan>

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
  // Recovered once and used twice: the 'rotate' proof and the recovery-anchor
  // verification both need the OLD epoch's signing key. Deriving it from local
  // key material is what makes the anchor check server-independent.
  const oldCanaryKey = await getCanaryKey(httpClient)

  // Proof FIRST — it must be signed with the OLD signing key, which the server
  // still holds until the rotate transaction commits.
  const proof = await buildProof(httpClient, 'rotate', oldCanaryKey)

  const oldAK = await getAK()
  if (!oldAK) {
    throw new Error('Account key not found in IndexedDB')
  }

  const recovery = await resolveRecovery(oldCanaryKey)
  // Random and machine-only — wrapping it to the recovery public keys needs no
  // private key, which is what makes a phrase-preserving rotation possible.
  const newAK = await generateAK(true)

  // Re-wrap the FULL live keyring under the new AK — re-wrapping only a subset
  // would strand the missing key_ids (esp. the `"v1"` slot) under the discarded
  // old AK (permanent data loss).
  const { keys } = await fetchWrappedKeys(httpClient)
  const { wrappedKeys, strandedKeyIds } = await rewrapKeyring(
    keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key })),
    oldAK,
    newAK,
  )
  const dek0Wrapped = wrappedKeys.find((entry) => entry.keyId === initialKeyId)?.wrappedKey
  if (!dek0Wrapped) {
    throw new Error(`Keyring is missing key_id '${initialKeyId}' — cannot rotate`)
  }
  // DEK '0' failing to open is not a poisoned row — it is the signature of a
  // STALE local AK, since '0' always exists and is always wrapped under the
  // current AK. Refresh and let the caller retry, rather than dying here: this
  // guard runs BEFORE `postRotate`, so it never reached the 4xx branch below
  // that does the refreshing, and a stale device stayed wedged on rotate until
  // some unrelated decode failure happened to fix it (THU-871).
  // NOTE: an `AKAnchorError` from the refresh propagates instead of the
  // retryable error. That is correct — nothing should rotate under an
  // unverifiable AK — but for `revokeDeviceAndRotate` the revoke has already
  // committed by this point, so the device ends up revoked without being
  // cryptographically locked out and `src/settings/devices.tsx` hides the
  // button that would resume it. That is THU-871's open "no retry affordance"
  // residual, reached by one more route; it is not made worse here beyond
  // adding the route.
  if (strandedKeyIds.includes(initialKeyId)) {
    await refreshAKForRotation(httpClient)
    throw new RotationStaleError()
  }
  if (strandedKeyIds.length > 0) {
    // Passed through with their original wrapping so one bad row cannot void the
    // rotation — and therefore cannot void a revocation. Logged loudly because a
    // row no device can open should not be silent: it is either planted or
    // corrupt.
    console.error(
      `[e2ee] keyring rows could not be re-wrapped and were passed through unchanged: ${strandedKeyIds.join(', ')}`,
    )
  }
  // The DEK rotation half, when this rotation is also one (revocation). Minted
  // under the NEW AK, so it needs no re-wrap and can never be stranded under a
  // stale AK, and it rides the rotate transaction so a failure adds no keyring
  // row at all — retrying a revocation cannot grow the keyring (THU-871).
  const mintedKeyId = opts.mintNewPrimary ? nextPrimaryKeyId(keys.map((key) => key.key_id)) : null
  const newPrimaryKey: WrappedKeyEntry | undefined = mintedKeyId
    ? { keyId: mintedKeyId, wrappedKey: (await mintDEK(newAK, mintedKeyId)).wrappedKey }
    : undefined

  // The pointer sealed into every envelope this rotation issues (THU-890): the
  // freshly minted id, or — on a non-mint rotation — this device's OWN stored
  // pointer, which itself only ever came from an adopted envelope. Never a
  // served metadata value, so a rollback cannot be laundered into a seal.
  const sealedPrimaryKeyId = mintedKeyId ?? (await getPrimaryKeyId())
  if (!sealedPrimaryKeyId) {
    throw new Error('No local primary key_id — cannot seal envelopes for this rotation')
  }

  // New-AK envelope for every live trusted device, minus explicit exclusions
  // (a just-revoked device may still look trusted through sync lag).
  const trustedDevices = await (opts.listTrustedDevices ?? (() => listTrustedDeviceKeys(httpClient)))()
  const envelopes = await buildDeviceEnvelopes(newAK, trustedDevices, sealedPrimaryKeyId, opts.excludeDeviceIds)

  // New canary under the NEW AK (THU-872) + new signing keypair. Independent of
  // the phrase, so this happens in BOTH modes — and it is what revocation's
  // bite rests on: the revoked device never receives the new AK, so its signing
  // identity dies with the old epoch.
  //
  // Minted BEFORE the recovery slot: the slot's attestation must be signed with
  // the NEW canary key, since that is the key the next rotation will derive
  // to verify it (THU-865).
  const { mintCanary, deriveSigningKeyPair } = await loadCanary()
  const { canaryIv, canaryCtext, canaryKey } = await mintCanary(newAK, getUserId())
  const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)

  const recoverySlot = await buildRecoverySlot(
    newAK,
    recovery.publicKeys,
    recovery.kdfSalt,
    canaryKey,
    sealedPrimaryKeyId,
  )

  // Built OUTSIDE the try below: a malformed escrow pin is a build
  // misconfiguration and must surface as-is, not masquerade as a stale-rotation 4xx.
  const orgEnvelope = await buildOrgEnvelope(newAK)

  try {
    await postRotate(httpClient, {
      proof,
      envelopes,
      wrappedKeys,
      newPrimaryKey,
      canaryIv,
      canaryCtext,
      signingPublicKey: publicKeySpki,
      kdfSalt: recovery.kdfSalt,
      ...recoverySlot,
      orgEnvelope,
      stepUpOtp: opts.stepUpOtp,
    })
  } catch (err) {
    if (err instanceof HttpError && err.response.status === 403) {
      // Step-up refusal (THU-875) is NOT staleness: local state is fine and a
      // refresh would be noise — surface it so the caller prompts for the code.
      const body = (await err.response.json().catch(() => null)) as { code?: string } | null
      if (body?.code === 'step_up_required' || body?.code === 'step_up_invalid') {
        throw new StepUpVerificationError(body.code, { cause: err })
      }
    }
    if (err instanceof HttpError && err.response.status >= 400 && err.response.status < 500) {
      // Stale local state (concurrent rotation / device change) — re-fetch our
      // envelope + keyring so the caller can rebuild and retry. This 4xx fires
      // precisely when another device rotated first, which is also exactly when
      // a torn envelope/keyring read is likely — hence the tolerant variant.
      await refreshAKForRotation(httpClient)
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
    await stageWrappedDEKs(newPrimaryKey ? [...wrappedKeys, newPrimaryKey] : wrappedKeys)
    invalidateKeyringCache()
    if (newPrimaryKey) {
      await storePrimaryKeyId(newPrimaryKey.keyId)
      // `invalidateKeyringCache` deliberately KEEPS the in-memory primary
      // pointer, so without this the codec would keep encrypting under the old
      // primary for the rest of the session even though the server moved on.
      resetCodecState()
    }
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
  runAKRotation(httpClient, (canaryKey) => readStoredRecoveryPlan(httpClient, canaryKey), opts)

/**
 * Explicit recovery-phrase change: rotates the AK AND re-anchors the recovery
 * slot to a freshly minted phrase, so the old phrase stops working. Returns the
 * NEW 24-word phrase — the caller MUST display it, it exists nowhere else.
 */
export const changeRecoveryPhrase = async (
  httpClient: HttpClient,
  opts: Pick<RotateAKOptions, 'listTrustedDevices' | 'stepUpOtp'> = {},
): Promise<string> => {
  const recovery = await mintRecoveryPlan()
  // Nothing to verify: this device minted the keys itself, so the served anchor
  // is never read. This is also the un-wedge for a v2 account whose row predates
  // the attestation column — one phrase change re-anchors it with a signed slot.
  await runAKRotation(httpClient, async () => recovery, opts)
  return recovery.recoveryPhrase
}

/**
 * Device revocation: cut server access, then rotate the AK AND mint a new
 * primary DEK in ONE atomic request. The AK rotation locks the removed device
 * out of the keyring (its envelope is gone and never re-issued); the new DEK
 * gives forward secrecy over future writes, under a key_id it never held.
 * Silent for the user: the recovery slot is re-anchored to the phrase they
 * already hold, so nothing needs to be shown.
 *
 * TWO STEPS, NOT THREE (THU-871). The DEK mint used to be its own request
 * between these two, and because it was neither atomic with the rotation nor
 * idempotent, the retry the rotation is *documented* to ask for
 * (`RotationStaleError`) minted another keyring row every time — so a user on a
 * flaky connection ratcheted their keyring toward the size at which no rotation
 * fits at all. Folded into `postRotate`, a failed attempt now adds nothing, and
 * the minted DEK is wrapped under the same AK the request installs, so it can
 * never be stranded under a stale one.
 *
 * ORDER IS LOAD-BEARING, AND THE CUT GOES FIRST ON PURPOSE (THU-887). Cutting
 * server access is the EMERGENCY half — someone is revoking a lost or stolen
 * device — while replacing the AK is the half that can fail. Making them one
 * atomic operation was tried and rejected: it puts the emergency behind the
 * failure-prone step, and two consequences were proved against it. A device
 * with a live session can deny its own revocation by looping `rotateAccountKey`
 * (every rotation replaces the signing key, invalidating the admin's in-flight
 * proof), and two devices whose public keys will not import wedge revocation
 * permanently, because revoking either still requires wrapping an envelope for
 * the other. Committing the cut independently is what keeps repair MONOTONE.
 *
 * So the residual is deliberate: between the cut and the rotation the removed
 * device still holds a live AK. It cannot reach the server, but it can read
 * what it already had plus anything written in that window. What closes the
 * loop is not atomicity but visibility — `listDevicesAwaitingLockout` makes an
 * outstanding rotation an observable account fact, so the UI can report it and
 * ANY device can finish it (see `finishDeviceLockout`).
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
  // Recovered ONCE for the whole revocation: the pre-flight below and the
  // revoke proof both need it. `refresh: false` is deliberate (THU-872): the
  // canary now opens only under the CURRENT AK, so a stale device cannot build
  // this proof from local material — but silently adopting a server-supplied
  // AK inside the emergency cut is exactly the dependency THU-887 removed.
  // Surface `StaleKeyMaterialError` instead; the UI offers an explicit
  // "refresh keys, then retry" step.
  const canaryKey = await getCanaryKey(httpClient, { refresh: false })

  // PRE-FLIGHT, DELIBERATELY DISCARDED. This is the check that fails closed on
  // a served recovery anchor that does not verify (THU-865) and on an account
  // with no recovery slot at all — between them the likeliest way the rotation
  // below dies. Running it BEFORE the cut turns both into an abort with nothing
  // applied, instead of a device that looks revoked and is not locked out.
  //
  // The result is NOT handed to the rotation, which must re-read the anchor
  // itself: a phrase change on another device between here and there would
  // otherwise be silently reverted by this stale-but-verified copy. One extra
  // metadata fetch is the price of that, and it buys the narrower window.
  await readStoredRecoveryPlan(httpClient, canaryKey)

  await revokeDeviceWithProof(httpClient, deviceId, canaryKey)

  // Past the cut. Everything from here is the rotation, and a failure means the
  // device is revoked but not locked out — tagged rather than propagated raw so
  // the UI can say which of the two happened instead of hedging both.
  try {
    await rotateAccountKey(httpClient, { ...opts, excludeDeviceIds: [deviceId], mintNewPrimary: true })
  } catch (err) {
    throw new LockoutIncompleteError({ cause: err })
  }
}

/**
 * Finish a revocation whose AK rotation never landed (THU-887): rotate the AK
 * and mint the fresh primary DEK that gives forward secrecy over the key the
 * removed device held.
 *
 * Takes no device id, and needs none — the target is already revoked, so it is
 * already absent from the server's own `listEnvelopeCapableDevices` predicate
 * and needs no exclusion. Callers find the accounts that need this from
 * `fetchLockoutPending`, not from local state, which is what lets a revocation
 * that failed on one device be completed from another.
 *
 * Never called automatically. An auto-retry driven by a server-supplied "this
 * is owed" signal would hand a malicious server an induced-rotation loop, and
 * every rotation mints a keyring row — inventing a denial-of-service to fix a
 * visibility bug.
 */
export const finishDeviceLockout = (httpClient: HttpClient): Promise<void> =>
  rotateAccountKey(httpClient, { mintNewPrimary: true })

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

/** The legacy CK the migrator will absorb, plus the D1 possession proof it produced. */
type AbsorbedLegacyCK = { legacyCK: CryptoKey; possessionProof: string }

/**
 * Whether `candidate` is the same AES-GCM key as the CK this device kept from v1.
 *
 * A probe rather than a byte comparison because v1 stored the CK
 * NON-EXTRACTABLE (`storeCK(nonExtractableCK)` on the v1 branch), so neither key
 * can be exported — and for the same reason the local copy can never be wrapped
 * into the keyring itself. Sealing under one key and opening under the other
 * proves equality without extracting either: a GCM auth tag cannot be satisfied
 * by a different key.
 */
const ckMatchesLocal = async (localCK: CryptoKey, candidate: CryptoKey): Promise<boolean> => {
  const probe = crypto.randomUUID()
  const sealed = await encrypt(probe, localCK)
  try {
    return (await decrypt(sealed, candidate)) === probe
  } catch {
    return false
  }
}

/**
 * Refuse a server-offered legacy CK that provably is not this account's (THU-877).
 *
 * FAILS CLOSED, unlike `runContinuityCheck`, which runs the same shape on the
 * FOLLOWER path behind the server-side D1 proof and must never block an unlock.
 * Here the envelope is the only thing between a forged CK and every pre-migration
 * row, and absorbing the wrong one seals that data under a key nobody holds. It
 * throws rather than returning `not-eligible` because a provably-wrong CK is
 * tampering, not an ineligible device, and must not be retried silently at boot.
 *
 * Order matters. A candidate that decrypts this account's own legacy ciphertext
 * IS the CK — a GCM auth tag cannot be forged — so that check settles the
 * question and returns. Only when no legacy row has synced yet does the locally
 * retained CK become the anchor.
 *
 * That ordering is deliberate: comparing against the local CK FIRST would reject
 * a legitimate migration on a browser carrying a previous account's leftover CK
 * (a wipe that threw and was logged-and-continued, `src/lib/cleanup.ts`). Once a
 * sample has settled it, the local copy is never consulted, so that false
 * positive is confined to the no-sample case — where it is loud, and where the
 * alternative is poisoning the keyring for every device on the account.
 *
 * Residual: with neither a synced legacy row nor a local CK there is nothing to
 * verify against and a forged envelope is still absorbed. Siblings then refuse the
 * poisoned keyring in `followToV2`, so it cannot spread past this device.
 */
const assertCandidateCKIsOurs = async (
  candidate: CryptoKey,
  getSample: () => Promise<LegacyV1Sample | null>,
): Promise<void> => {
  const sample = await getSample()
  if (sample) {
    if (!(await ckOpensLegacySample(candidate, sample))) {
      throw new Error(
        "E2EE migration aborted — the legacy key the server offered cannot decrypt this account's own legacy " +
          'data, so absorbing it would orphan every pre-migration row (THU-877)',
      )
    }
    return
  }

  const localCK = await getLegacyCK()
  if (localCK && !(await ckMatchesLocal(localCK, candidate))) {
    throw new Error(
      'E2EE migration aborted — the legacy key the server offered does not match the one this device kept from ' +
        'v1 (THU-877)',
    )
  }
}

/** Unwrap the legacy CK from this device's v1 envelope and prove it is ours before absorbing it. */
const resolveLegacyCK = async (
  httpClient: HttpClient,
  canary: { iv: string; ctext: string },
  keyPair: StoredKeyPair,
  getSample: () => Promise<LegacyV1Sample | null>,
): Promise<AbsorbedLegacyCK | null> => {
  const { wrappedCK } = await fetchMyEnvelope(httpClient)
  const legacyCK = await unwrapLegacyCK(wrappedCK, keyPair.ecdhPrivateKey, keyPair.mlkemSecretKey).catch(() => null)
  if (!legacyCK) {
    return null
  }
  // D1 possession proof: only a CK matching the served canary recovers its secret.
  // A2 authors both the envelope and the canary, so this alone proves nothing —
  // hence the check below, against material A2 does not author.
  const { recoverCanarySecretV1 } = await loadCanary()
  const possessionProof = await recoverCanarySecretV1(legacyCK, canary.iv, canary.ctext)
  if (!possessionProof) {
    return null
  }
  await assertCandidateCKIsOurs(legacyCK, getSample)
  return { legacyCK, possessionProof }
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

  // Absorb the legacy CK — preferring this device's own copy over the one the
  // server offers, and never absorbing a server-offered CK that cannot open this
  // account's real legacy data (THU-877).
  const absorbed = await resolveLegacyCK(
    httpClient,
    { iv: metadata.canary_iv, ctext: metadata.canary_ctext },
    keyPair,
    opts.getLegacyV1Sample ?? defaultGetLegacyV1Sample,
  )
  if (!absorbed) {
    return { outcome: 'not-eligible' }
  }
  const { legacyCK, possessionProof } = absorbed

  // Mint the new AK + fresh primary DEK '0'; absorb the CK as the '"v1"' slot.
  const recovery = await mintRecoveryPlan()
  const newAK = await generateAK(true)

  const { wrappedKey: wrappedDek0 } = await mintDEK(newAK, initialKeyId)
  const wrappedV1 = await wrapDEK(legacyCK, newAK, legacyKeyId)

  // Anchored to the new AK (THU-872); the v1 possession proof below still uses
  // the LEGACY canary the server currently stores — two different artifacts.
  const { mintCanary, deriveSigningKeyPair } = await loadCanary()
  const { canaryIv, canaryCtext, canaryKey } = await mintCanary(newAK, getUserId())
  const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)

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
  const envelopes = await buildDeviceEnvelopes(newAK, devicesToCover, initialKeyId)
  const recoverySlot = await buildRecoverySlot(newAK, recovery.publicKeys, recovery.kdfSalt, canaryKey, initialKeyId)

  const { nonce } = await fetchChallenge(httpClient, 'upgrade')

  // Built OUTSIDE the try below: a malformed escrow pin is a build
  // misconfiguration and must surface as-is, not be re-classified as a 409 CAS-loss.
  const orgEnvelope = await buildOrgEnvelope(newAK)

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
    // Same reasoning as first-device setup: witness DEK "0" from the AK this
    // device just minted, not from whatever a later keyring fetch returns.
    await reconcileKeyringAnchor()
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
 *
 * DELIBERATELY DIVERGENT from `assertCandidateAKIsOurs`, which has the same
 * shape (verify a server-supplied keyring against locally-held ciphertext) and
 * the opposite failure policy. This one SKIPS when no sample exists and
 * swallows errors into a skip, because it is defence-in-depth behind the
 * server-side D1 proof and must never block an unlock. That one FAILS CLOSED,
 * because it is the only thing standing between a malicious server and every
 * future write. Do not harmonize them.
 */
const ckOpensLegacySample = async (ck: CryptoKey, sample: LegacyV1Sample): Promise<boolean> => {
  try {
    await decrypt({ iv: sample.iv, ciphertext: sample.ciphertext }, ck)
    return true
  } catch {
    return false
  }
}

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
  const v1Dek = await unwrapDEK(wrappedV1, ak, legacyKeyId)
  if (!(await ckOpensLegacySample(v1Dek, sample))) {
    throw new Error('E2EE continuity check failed — the staged keyring could not decrypt legacy data')
  }
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

  const { ak, primaryKeyId: sealedPrimaryKeyId } = await unwrapAK(
    envelope.wrappedCK,
    keyPair.ecdhPrivateKey,
    keyPair.mlkemSecretKey,
  )

  const fetched = await fetchKeyring(httpClient)
  const keyring: WrappedKeyEntry[] = fetched.keys.map((key) => ({ keyId: key.key_id, wrappedKey: key.wrapped_key }))
  await runContinuityCheck(ak, keyring, opts.getLegacyV1Sample ?? defaultGetLegacyV1Sample)

  await storeAK(ak)
  // Persist the keyring the continuity check just VERIFIED. This used to call
  // `stageKeyring`, which re-fetched — so the checked keyring and the stored one
  // were different reads, and that call could itself adopt a fresh envelope AK,
  // un-setting the AK verified two lines above (THU-869). Going straight to
  // `applyKeyring` also means a follow can no longer reach an adoption path at
  // all, which is the property rather than a side effect.
  //
  // No DEK "0" witness check here: a follow only runs with no local AK
  // (`ensureV2Encryption` short-circuits on one), so there is never an anchor to
  // check against. The v1 continuity check above is this path's anchor.
  await applyKeyring(fetched, sealedPrimaryKeyId)

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
