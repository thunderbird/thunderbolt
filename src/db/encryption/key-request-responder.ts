/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { fetchEncryptionMetadata, type EncryptionMetadata } from '@/api/encryption'
import { getKeyVersion, storeKeyVersion } from '@/crypto/key-storage'
import type { KeyId } from '@shared/e2ee-types'
import { isEncryptionEnabled, needsSyncSetupWizard } from './config'
import { keysSyncChannelName, type KeyRequestReason, type KeysSyncChannel, type KeysSyncMessage } from './codec'

// =============================================================================
// Main-thread key-request responder (plan §3 / D2 + the polling half of C3).
//
// The codec's decode path (usually inside the SharedWorker, which has
// IndexedDB but NO auth token) posts `key-request` on the
// `thunderbolt-keys-sync` BroadcastChannel when it cannot resolve a DEK. This
// responder lives on the main thread — where an authenticated HttpClient
// exists — and answers by fetching + staging key material into IndexedDB:
// - `unknown-key`  → stageKeyring (fetch every wrapped DEK) → post `key-staged`
// - `unwrap-failed` → refreshAK (re-fetch this device's replaced envelope,
//   unwrap the new AK, re-stage) → post `ak-refreshed` — the post-revocation
//   case: revocation rotates AK and DEK together, so the new DEK only unwraps
//   under the new AK.
//
// key_version polling: every encryption-metadata fetch (startup prime + each
// handled request) is compared against the last key_version this device
// applied (persisted in IndexedDB). A strictly-higher version means the AK
// was rotated → refreshAK. An AK rotation with unchanged DEKs therefore costs
// one envelope fetch + cheap re-staging and never interrupts sync.
// =============================================================================

/** How long a failed attempt suppresses re-runs for the same key_id (loop guard). */
const defaultCooldownMs = 30_000

type ResponderAction = 'stage' | 'refresh'

export type KeyRequestResponderDeps = {
  httpClient: HttpClient
  /**
   * `stageKeyring` from `@/services/encryption` — injected by the caller
   * because services imports the `@/db/encryption` barrel (a direct import
   * here would create a module cycle).
   */
  stageKeyring: (httpClient: HttpClient) => Promise<void>
  /** `refreshAK` from `@/services/encryption` — injected for the same reason. */
  refreshAK: (httpClient: HttpClient) => Promise<void>
  /** Metadata fetch seam (tests); defaults to the real API client. */
  fetchMetadata?: (httpClient: HttpClient) => Promise<Pick<EncryptionMetadata, 'key_version'>>
  /**
   * Keys-sync channel seam (tests). `undefined` → own a real BroadcastChannel;
   * `null` → inert (no BroadcastChannel support in this environment).
   */
  channel?: KeysSyncChannel | null
  /** Clock seam (tests); defaults to Date.now. */
  now?: () => number
  cooldownMs?: number
}

export type KeyRequestResponder = {
  /** Settles when the startup staging pass (incl. key_version check) finished. Never rejects. */
  ready: Promise<void>
  stop: () => void
}

const createBroadcastChannel = (): { channel: KeysSyncChannel; close: () => void } | null => {
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

/**
 * Create (and immediately start) a key-request responder. Prefer
 * `startKeyRequestResponder` in app code — this factory exists so tests can
 * inject fakes and run isolated instances.
 */
export const createKeyRequestResponder = (deps: KeyRequestResponderDeps): KeyRequestResponder => {
  const {
    httpClient,
    stageKeyring,
    refreshAK,
    fetchMetadata = fetchEncryptionMetadata,
    now = () => Date.now(),
    cooldownMs = defaultCooldownMs,
  } = deps

  const ownedChannel = deps.channel === undefined ? createBroadcastChannel() : null
  const channel = deps.channel !== undefined ? deps.channel : (ownedChannel?.channel ?? null)

  let active = true
  let lastKeyVersion: number | null = null
  const inflight = new Map<KeyId, Promise<void>>()
  const lastAttempts = new Map<KeyId, { action: ResponderAction; at: number }>()

  /** A polled key_version strictly newer than the last one applied means the AK was rotated. */
  const isVersionBump = (version: number): boolean => lastKeyVersion !== null && version > lastKeyVersion

  const recordKeyVersion = async (version: number): Promise<void> => {
    lastKeyVersion = version
    await storeKeyVersion(version)
  }

  const refreshAndAnnounce = async (): Promise<void> => {
    await refreshAK(httpClient)
    channel?.postMessage({ type: 'ak-refreshed' })
  }

  /**
   * Loop guard: if staging didn't produce the key, the codec's fail-open path
   * keeps decoding rows under it — don't re-fetch the same key_id more than
   * once per cooldown window. An `unwrap-failed` escalation may still bypass a
   * recent stage-only attempt (it upgrades the response to an AK refresh).
   */
  const isOnCooldown = (keyId: KeyId, reason: KeyRequestReason): boolean => {
    const last = lastAttempts.get(keyId)
    if (!last || now() - last.at >= cooldownMs) {
      return false
    }
    return !(reason === 'unwrap-failed' && last.action === 'stage')
  }

  const runKeyRequest = async (keyId: KeyId, reason: KeyRequestReason): Promise<void> => {
    lastAttempts.set(keyId, { action: reason === 'unwrap-failed' ? 'refresh' : 'stage', at: now() })
    const metadata = await fetchMetadata(httpClient)
    if (reason === 'unwrap-failed' || isVersionBump(metadata.key_version)) {
      lastAttempts.set(keyId, { action: 'refresh', at: now() })
      await refreshAndAnnounce()
    } else {
      await stageKeyring(httpClient)
      channel?.postMessage({ type: 'key-staged', keyId })
    }
    await recordKeyVersion(metadata.key_version)
  }

  const handleKeyRequest = (keyId: KeyId, reason: KeyRequestReason): Promise<void> => {
    const pending = inflight.get(keyId)
    if (pending) {
      return pending
    }
    if (isOnCooldown(keyId, reason)) {
      return Promise.resolve()
    }
    const run = runKeyRequest(keyId, reason)
      .catch((err: unknown) => {
        console.warn(`[keys-sync] key-request for key_id '${keyId}' (${reason}) failed:`, err)
      })
      .finally(() => {
        inflight.delete(keyId)
      })
    inflight.set(keyId, run)
    return run
  }

  /**
   * Startup staging for an already-set-up device: load the persisted
   * key_version baseline, fetch fresh metadata, and either refresh the AK (a
   * rotation happened while this device was away) or pre-stage the keyring
   * for the worker.
   */
  const prime = async (): Promise<void> => {
    if (!isEncryptionEnabled() || (await needsSyncSetupWizard())) {
      return
    }
    lastKeyVersion = await getKeyVersion()
    const metadata = await fetchMetadata(httpClient)
    if (isVersionBump(metadata.key_version)) {
      await refreshAndAnnounce()
    } else {
      await stageKeyring(httpClient)
    }
    await recordKeyVersion(metadata.key_version)
  }

  channel?.onMessage((message) => {
    if (!active || message.type !== 'key-request') {
      return
    }
    void handleKeyRequest(message.keyId, message.reason)
  })

  const ready = prime().catch((err: unknown) => {
    console.warn('[keys-sync] startup keyring staging failed:', err)
  })

  return {
    ready,
    stop: () => {
      active = false
      ownedChannel?.close()
    },
  }
}

let activeResponder: KeyRequestResponder | null = null

/**
 * Start the singleton main-thread key-request responder — called once per tab
 * from app initialization (after the authenticated HttpClient exists).
 * Idempotent across init retries: a repeat call stops the previous instance
 * and starts a fresh one with the new dependencies.
 */
export const startKeyRequestResponder = (deps: KeyRequestResponderDeps): KeyRequestResponder => {
  activeResponder?.stop()
  activeResponder = createKeyRequestResponder(deps)
  return activeResponder
}
