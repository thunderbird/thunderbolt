/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { decrypt, encrypt, getAK, getDEK, getPrimaryKeyId, unwrapDEK } from '@/crypto'
import {
  encodeAAD,
  initialKeyId,
  legacyKeyId,
  type EncryptionCodec,
  type EncryptionContext,
  type KeyId,
} from '@shared/e2ee-types'
import { encPrefix, formatWireValue, isEncryptedValue, isV2EncryptedValue, parseWireValue } from './wire-format'

export type { EncryptionCodec, EncryptionContext }

// =============================================================================
// Keyring cache — lazy-loaded from IndexedDB (AK + wrapped DEKs staged by the
// main thread), invalidated over BroadcastChannel. Works in both the main
// thread and the SharedWorker (both have IndexedDB; the worker has no auth
// token, so it can only read what the main thread staged — see plan §3).
//
// Replaces the v1 single-CK cache with a key_id-indexed keyring cache plus a
// primary-key pointer, so v2's dual-read can resolve any DEK version (incl. the
// reserved read-only "v1" slot) by its wire key_id.
// =============================================================================

let cachedAK: CryptoKey | null = null
let cachedPrimaryKeyId: KeyId | null = null
const dekCache = new Map<KeyId, CryptoKey>()
let e2eeSetupComplete = false

/** Channel name shared by every codec instance and the main-thread key responder (D2). */
export const keysSyncChannelName = 'thunderbolt-keys-sync'

export type KeyRequestReason = 'unknown-key' | 'unwrap-failed'

/**
 * Message contract on the `thunderbolt-keys-sync` BroadcastChannel (v2 rename of
 * the v1 `thunderbolt-ck-invalidation` channel):
 * - `invalidate` — drop the staged DEK + AK caches (re-read IndexedDB on next
 *   use); the primary-key pointer is kept.
 * - `reset` — drop ALL caches (incl. the primary pointer) AND clear the
 *   e2ee-setup-complete flag (sign-out / account switch).
 * - `key-request` — posted BY the codec when decode hits a key_id with no
 *   staged wrapped DEK (`unknown-key`) or one that fails to unwrap under the
 *   current AK (`unwrap-failed`, the post-revocation AK-refresh case). Answered
 *   by the main thread (D2), which fetches + stages the key.
 * - `key-staged` — posted by the main thread after staging a wrapped DEK; the
 *   codec drops that key_id's cache entry and retries.
 * - `ak-refreshed` — posted by the main thread after refreshing the AK; the
 *   codec drops the AK + all DEK caches and retries.
 */
export type KeysSyncMessage =
  | { type: 'invalidate' }
  | { type: 'reset' }
  | { type: 'key-request'; keyId: KeyId; reason: KeyRequestReason }
  | { type: 'key-staged'; keyId: KeyId }
  | { type: 'ak-refreshed' }

export type KeysSyncChannel = {
  postMessage: (message: KeysSyncMessage) => void
  onMessage: (listener: (message: KeysSyncMessage) => void) => void
}

/** A keys-sync channel plus the handle needed to close its underlying BroadcastChannel. */
type OwnedKeysSyncChannel = { channel: KeysSyncChannel; close: () => void }

const createBroadcastKeysSyncChannel = (): OwnedKeysSyncChannel | null => {
  if (typeof BroadcastChannel === 'undefined') {
    return null
  }
  const broadcast = new BroadcastChannel(keysSyncChannelName)
  return {
    channel: {
      postMessage: (message) => broadcast.postMessage(message),
      onMessage: (listener) =>
        broadcast.addEventListener('message', (event: MessageEvent<KeysSyncMessage>) => listener(event.data)),
    },
    close: () => broadcast.close(),
  }
}

/** Drop the keyring caches (AK + staged DEKs) but KEEP the primary-key pointer. */
const dropKeyringCaches = () => {
  cachedAK = null
  dekCache.clear()
}

/** Full clear including the primary-key pointer (sign-out / account switch). */
const dropAllCaches = () => {
  cachedAK = null
  cachedPrimaryKeyId = null
  dekCache.clear()
}

// =============================================================================
// Pending key requests — coalesced per key_id so parallel buckets decoding the
// same unknown key fire a single request (plan §3 "stall then self-heal").
// =============================================================================

const keyRequestTimeoutMs = 10_000

type PendingKeyRequest = {
  promise: Promise<void>
  settle: () => void
}

const pendingKeyRequests = new Map<KeyId, PendingKeyRequest>()

const settleAllPendingRequests = () => {
  for (const pending of [...pendingKeyRequests.values()]) {
    pending.settle()
  }
}

/**
 * Post a `key-request` and wait until the main thread stages the key
 * (`key-staged` / `ak-refreshed`) or the timeout elapses. Concurrent waits for
 * the same key_id share one request.
 */
const requestKeyAndWait = (keyId: KeyId, reason: KeyRequestReason): Promise<void> => {
  const existing = pendingKeyRequests.get(keyId)
  if (existing) {
    return existing.promise
  }
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  const pending: PendingKeyRequest = {
    promise,
    settle: () => {
      clearTimeout(timeoutId)
      pendingKeyRequests.delete(keyId)
      resolvePromise()
    },
  }
  const timeoutId = setTimeout(pending.settle, keyRequestTimeoutMs)
  pendingKeyRequests.set(keyId, pending)
  channel?.postMessage({ type: 'key-request', keyId, reason })
  return promise
}

const handleKeysSyncMessage = (message: KeysSyncMessage) => {
  switch (message.type) {
    case 'invalidate':
      dropKeyringCaches()
      break
    case 'reset':
      dropAllCaches()
      e2eeSetupComplete = false
      settleAllPendingRequests()
      break
    case 'key-staged':
      dekCache.delete(message.keyId)
      pendingKeyRequests.get(message.keyId)?.settle()
      break
    case 'ak-refreshed':
      dropKeyringCaches()
      settleAllPendingRequests()
      break
    // 'key-request' is answered by the main thread (D2), not by codecs.
  }
}

// Eager listen from import time so a codec receives cross-context invalidations
// (reset/invalidate/key-staged/ak-refreshed) even if it never encodes/decodes.
let ownedRealChannel = createBroadcastKeysSyncChannel()
let channel: KeysSyncChannel | null = ownedRealChannel?.channel ?? null
channel?.onMessage(handleKeysSyncMessage)

/**
 * Test seam: replace the BroadcastChannel-backed keys-sync channel so tests can
 * observe posted messages and inject incoming ones. Closes the module-load real
 * BroadcastChannel (or any previously-owned one) so importing the codec never
 * leaves a live channel open across tests.
 * @internal
 */
export const setKeysSyncChannelForTesting = (next: KeysSyncChannel | null) => {
  ownedRealChannel?.close()
  ownedRealChannel = null
  channel = next
  channel?.onMessage(handleKeysSyncMessage)
}

/**
 * Drop the staged DEK + AK caches (keeping the primary pointer) and broadcast to
 * other contexts (SharedWorker, other tabs). FROZEN name — Track E imports this.
 */
export const invalidateKeyringCache = () => {
  dropKeyringCaches()
  channel?.postMessage({ type: 'invalidate' })
}

/**
 * Full reset for sign-out / account switch: drops every cache (incl. the primary
 * pointer), clears the setup flag, settles pending requests, and broadcasts.
 * FROZEN name — Track E imports this.
 */
export const resetCodecState = () => {
  dropAllCaches()
  e2eeSetupComplete = false
  settleAllPendingRequests()
  channel?.postMessage({ type: 'reset' })
}

// =============================================================================
// DEK resolution
// =============================================================================

const getCachedAK = async (): Promise<CryptoKey | null> => {
  if (!cachedAK) {
    cachedAK = await getAK()
  }
  return cachedAK
}

type DekResolution = { dek: CryptoKey } | { failure: 'no-keys' | KeyRequestReason }

const resolveDEK = async (keyId: KeyId): Promise<DekResolution> => {
  const cached = dekCache.get(keyId)
  if (cached) {
    return { dek: cached }
  }
  const ak = await getCachedAK()
  if (!ak) {
    return { failure: 'no-keys' }
  }
  const wrapped = await getDEK(keyId)
  if (!wrapped) {
    return { failure: 'unknown-key' }
  }
  try {
    const dek = await unwrapDEK(wrapped, ak)
    dekCache.set(keyId, dek)
    e2eeSetupComplete = true
    return { dek }
  } catch {
    return { failure: 'unwrap-failed' }
  }
}

/**
 * Resolve a DEK, and on unknown-key / unwrap-failed signal the main thread
 * (plan §3) and retry once after the key lands (or the timeout elapses).
 */
const resolveDEKWithRetry = async (keyId: KeyId): Promise<DekResolution> => {
  const first = await resolveDEK(keyId)
  if ('dek' in first || first.failure === 'no-keys') {
    return first
  }
  await requestKeyAndWait(keyId, first.failure)
  if (first.failure === 'unwrap-failed') {
    // Post-revocation the DEK is re-wrapped under a NEW AK — re-read it too.
    cachedAK = null
  }
  return resolveDEK(keyId)
}

const resolvePrimaryKeyId = async (): Promise<KeyId | null> => {
  if (cachedPrimaryKeyId) {
    return cachedPrimaryKeyId
  }
  const stored = await getPrimaryKeyId()
  if (stored) {
    cachedPrimaryKeyId = stored
    return stored
  }
  if (await getDEK(initialKeyId)) {
    cachedPrimaryKeyId = initialKeyId
    return initialKeyId
  }
  return null
}

/**
 * Fail-open before setup, fail-closed after: plaintext may pass through only on
 * an account that never completed E2EE setup.
 */
const encodeWithoutKeys = async (plaintext: string): Promise<string> => {
  // Fail closed if E2EE setup has completed at any point. The in-memory flag
  // catches the current session; a PERSISTED AK catches a fresh worker/reload
  // where a primary key_id is not yet resolvable (e.g. a follower still
  // provisioning) — never let an already-encrypted account upload plaintext.
  if (e2eeSetupComplete || (await getAK()) != null) {
    throw new Error('Encryption keys unavailable after E2EE setup — refusing to upload plaintext')
  }
  return plaintext
}

/**
 * Decode a legacy v1 value (`__enc:<iv>:<ct>`) via the reserved read-only "v1"
 * DEK slot, with NO AAD (matching how v1 wrote it). The slot rides the staged
 * keyring; if it is not staged yet, resolution self-heals over the key-request
 * channel (plan §2.5 migration interaction).
 */
const decodeLegacyV1 = async (encoded: string): Promise<string> => {
  const payload = encoded.slice(encPrefix.length)
  const separatorIdx = payload.indexOf(':')
  if (separatorIdx === -1) {
    return encoded
  }
  const iv = payload.slice(0, separatorIdx)
  const ciphertext = payload.slice(separatorIdx + 1)
  const resolution = await resolveDEKWithRetry(legacyKeyId)
  if ('failure' in resolution) {
    return encoded
  }
  try {
    return await decrypt({ iv, ciphertext }, resolution.dek)
  } catch (err) {
    console.warn('[codec] Legacy v1 decryption failed, returning raw value:', err)
    return encoded
  }
}

// =============================================================================
// AES-GCM codec — __enc:v2:<key_id>:<iv-b64>:<ct-b64>, AAD-bound (THU-426), with
// dual-read of legacy v1 values via the "v1" slot (plan §2.3).
// =============================================================================

export const codec: EncryptionCodec = {
  async encode(plaintext: string, ctx?: EncryptionContext): Promise<string> {
    if (!ctx) {
      throw new Error('codec.encode requires an EncryptionContext — AAD cannot be built without it')
    }
    const keyId = await resolvePrimaryKeyId()
    if (!keyId) {
      // No primary key resolvable — a genuinely pre-E2EE account (plaintext
      // passes through) or a half-provisioned device (encodeWithoutKeys fails
      // closed if a staged AK / prior unlock signals setup already happened).
      return encodeWithoutKeys(plaintext)
    }
    // A persisted primary key_id proves E2EE setup completed. If the DEK can't
    // be resolved right now (AK not staged yet after a reload, or unwrap
    // failure), FAIL CLOSED — never fall back to plaintext for a set-up account.
    const resolution = await resolveDEK(keyId)
    if ('failure' in resolution) {
      throw new Error('Encryption keys unavailable while E2EE is set up — refusing to upload plaintext')
    }
    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, keyId)
    const { iv, ciphertext } = await encrypt(plaintext, resolution.dek, aad)
    return formatWireValue(keyId, iv, ciphertext)
  },

  async decode(encoded: string, ctx?: EncryptionContext): Promise<string> {
    if (!isEncryptedValue(encoded)) {
      return encoded
    }
    if (!isV2EncryptedValue(encoded)) {
      return decodeLegacyV1(encoded)
    }
    const parsed = parseWireValue(encoded)
    if (!parsed) {
      // Malformed v2 value — nothing to decrypt.
      return encoded
    }
    if (!ctx) {
      console.warn('[codec] v2 value decoded without EncryptionContext — cannot rebuild AAD, returning raw value')
      return encoded
    }
    const { keyId, iv, ciphertext } = parsed
    const resolution = await resolveDEKWithRetry(keyId)
    if ('failure' in resolution) {
      // Final pre-unlock fail-open fallback.
      return encoded
    }
    try {
      return await decrypt({ iv, ciphertext }, resolution.dek, encodeAAD(ctx.table, ctx.column, ctx.rowId, keyId))
    } catch (err) {
      console.warn('[codec] Decryption failed (AES-GCM auth), returning raw value:', err)
      return encoded
    }
  },
}
