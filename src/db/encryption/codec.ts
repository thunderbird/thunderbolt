/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { decrypt, encrypt, unwrapDEK } from '@/crypto/primitives'
import { getAK, getPrimaryKeyId, getWrappedDEK } from '@/crypto/key-storage'
import { encodeAAD, initialKeyId, type EncryptionCodec, type EncryptionContext, type KeyId } from '@shared/e2ee-types'
import { formatWireValue, isEncryptedValue, parseWireValue } from './wire-format'

export type { EncryptionCodec, EncryptionContext }

// =============================================================================
// Keyring cache — lazy-loaded from IndexedDB (AK + wrapped DEKs staged by the
// main thread), invalidated over BroadcastChannel. Works in both the main
// thread and the SharedWorker (both have IndexedDB; the worker has no auth
// token, so it can only read what the main thread staged — see plan §3).
// =============================================================================

let cachedAK: CryptoKey | null = null
let cachedPrimaryKeyId: KeyId | null = null
const dekCache = new Map<KeyId, CryptoKey>()
let e2eeSetupComplete = false
let v1ValueLogged = false

/** Channel name shared by every codec instance and the main-thread key responder (D2). */
export const keysSyncChannelName = 'thunderbolt-keys-sync'

export type KeyRequestReason = 'unknown-key' | 'unwrap-failed'

/**
 * Message contract on the `thunderbolt-keys-sync` BroadcastChannel (replaces
 * the v1 `thunderbolt-ck-invalidation` channel):
 * - `invalidate` — drop all in-memory key caches (re-read IndexedDB on next use).
 * - `reset` — drop caches AND clear the e2ee-setup-complete flag (sign-out/wipe).
 * - `key-request` — posted BY the codec when decode hits a key_id with no
 *   staged wrapped DEK (`unknown-key`) or one that fails to unwrap under the
 *   current AK (`unwrap-failed`, the post-revocation AK-refresh case).
 *   Answered by the main thread (D2), which fetches + stages the key.
 * - `key-staged` — posted by the main thread after staging a wrapped DEK; the
 *   codec drops that key_id's cache entry and retries.
 * - `ak-refreshed` — posted by the main thread after refreshing the AK; the
 *   codec drops the AK + all DEK caches and retries.
 */
export type KeysSyncMessage =
  | { type: 'invalidate' }
  | { type: 'reset' }
  | { type: 'key-request'; keyId: string; reason: KeyRequestReason }
  | { type: 'key-staged'; keyId: string }
  | { type: 'ak-refreshed' }

export type KeysSyncChannel = {
  postMessage: (message: KeysSyncMessage) => void
  onMessage: (listener: (message: KeysSyncMessage) => void) => void
}

const createBroadcastKeysSyncChannel = (): KeysSyncChannel | null => {
  if (typeof BroadcastChannel === 'undefined') {
    return null
  }
  const broadcast = new BroadcastChannel(keysSyncChannelName)
  return {
    postMessage: (message) => broadcast.postMessage(message),
    onMessage: (listener) =>
      broadcast.addEventListener('message', (event: MessageEvent<KeysSyncMessage>) => listener(event.data)),
  }
}

const dropKeyCaches = () => {
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
      dropKeyCaches()
      break
    case 'reset':
      dropKeyCaches()
      e2eeSetupComplete = false
      settleAllPendingRequests()
      break
    case 'key-staged':
      dekCache.delete(message.keyId)
      pendingKeyRequests.get(message.keyId)?.settle()
      break
    case 'ak-refreshed':
      dropKeyCaches()
      settleAllPendingRequests()
      break
    // 'key-request' is answered by the main thread (D2), not by codecs.
  }
}

let channel = createBroadcastKeysSyncChannel()
channel?.onMessage(handleKeysSyncMessage)

/**
 * Test seam: replace the BroadcastChannel-backed keys-sync channel so tests
 * can observe posted messages and inject incoming ones.
 * @internal
 */
export const setKeysSyncChannelForTesting = (next: KeysSyncChannel | null) => {
  channel = next
  channel?.onMessage(handleKeysSyncMessage)
}

/** Drop all in-memory key caches and broadcast to other contexts (SharedWorker, other tabs). */
export const invalidateKeyCache = () => {
  dropKeyCaches()
  channel?.postMessage({ type: 'invalidate' })
}

/** Full reset for sign-out/wipe: drops caches, clears the setup flag, and broadcasts. */
export const resetCodecState = () => {
  dropKeyCaches()
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
  const wrapped = await getWrappedDEK(keyId)
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
  if (await getWrappedDEK(initialKeyId)) {
    cachedPrimaryKeyId = initialKeyId
    return initialKeyId
  }
  return null
}

/**
 * Fail-open before setup, fail-closed after: plaintext may pass through only
 * on an account that never completed E2EE setup.
 */
const encodeWithoutKeys = (plaintext: string): string => {
  if (e2eeSetupComplete) {
    throw new Error('Encryption keys unavailable after E2EE setup — refusing to upload plaintext')
  }
  return plaintext
}

// =============================================================================
// AES-GCM codec — __enc:v2:<key_id>:<iv-b64>:<ct-b64>, AAD-bound (THU-426)
// =============================================================================

export const codec: EncryptionCodec = {
  async encode(plaintext: string, ctx?: EncryptionContext): Promise<string> {
    if (!ctx) {
      throw new Error('codec.encode requires an EncryptionContext — AAD cannot be built without it')
    }
    const keyId = await resolvePrimaryKeyId()
    if (!keyId) {
      return encodeWithoutKeys(plaintext)
    }
    const resolution = await resolveDEK(keyId)
    if ('failure' in resolution) {
      return encodeWithoutKeys(plaintext)
    }
    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, keyId)
    const { iv, ciphertext } = await encrypt(plaintext, resolution.dek, aad)
    return formatWireValue(keyId, iv, ciphertext)
  },

  async decode(encoded: string, ctx?: EncryptionContext): Promise<string> {
    if (!isEncryptedValue(encoded)) {
      return encoded
    }
    const parsed = parseWireValue(encoded)
    if (!parsed) {
      // v1 `__enc:<iv>:<ct>` was written without AAD under a discarded CK
      // (beta reset) — decryption is guaranteed to fail, skip the doomed call.
      if (!v1ValueLogged) {
        v1ValueLogged = true
        // eslint-disable-next-line no-console
        console.debug('[codec] v1 encrypted value encountered — undecryptable by design (beta reset), returning raw')
      }
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
