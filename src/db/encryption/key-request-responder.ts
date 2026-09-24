/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getKeyVersion, storeKeyVersion } from '@/crypto'
import type { KeyId } from '@shared/e2ee-types'
import { needsSyncSetupWizard } from './config'
import { createBroadcastKeysSyncChannel, type KeyRequestReason, type KeysSyncChannel } from './codec'

// =============================================================================
// Main-thread key-request responder (plan §3 / D2 + the polling half of C3).
//
// The codec's decode path (usually inside the SharedWorker, which has IndexedDB
// but NO auth token) posts `key-request` on the `thunderbolt-keys-sync`
// BroadcastChannel when it cannot resolve a DEK. This responder lives on the
// main thread — where an authenticated HttpClient exists — and answers by
// fetching + staging key material into IndexedDB:
// - `unknown-key`  → stageKeyring (fetch every wrapped DEK) → post `key-staged`
// - `unwrap-failed` → refreshAK (re-fetch this device's replaced envelope,
//   unwrap the new AK, re-stage) → post `ak-refreshed` — the post-revocation
//   case: revocation rotates AK and DEK together, so the new DEK only unwraps
//   under the new AK.
//
// key_version polling (the C3 primary/version poll): every metadata fetch
// (startup prime + each handled request) is compared against the last
// key_version this device applied (persisted in IndexedDB). A strictly-higher
// version means the AK was rotated → refreshAK. An AK rotation with unchanged
// DEKs therefore costs one envelope fetch + cheap re-staging and never
// interrupts sync.
//
// `stageKeyring`/`refreshAK`/`fetchMetadata` are INJECTED (owned by Track E's
// service + API layers): importing them here would create a module cycle (the
// service imports the `@/db/encryption` barrel), so app init wires the concrete
// implementations at start.
// =============================================================================

/** How long a failed attempt suppresses re-runs for the same key_id (loop guard). */
const defaultCooldownMs = 30_000

type ResponderAction = 'stage' | 'refresh'

export type KeyRequestResponderDeps = {
  /**
   * `stageKeyring` (Track E) — fetch the full wrapped-DEK keyring and stage it
   * into IndexedDB for the worker.
   */
  stageKeyring: () => Promise<void>
  /**
   * `refreshAK` (Track E) — re-fetch this device's replaced AK envelope, unwrap
   * the new AK, and re-stage the re-wrapped keyring (post-revocation path).
   */
  refreshAK: () => Promise<void>
  /**
   * Encryption-metadata fetch (Track E API client) — read for the polled
   * `key_version` (the AK-rotation signal).
   */
  fetchMetadata: () => Promise<{ key_version: number }>
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
  /**
   * How many key_ids the loop guard is currently holding. Observability seam:
   * the bound on this map is a security property (key_ids are server-supplied
   * — see `pruneExpiredAttempts`) and pruning is deliberately invisible in
   * every other respect, so without this there is nothing to assert against.
   */
  trackedKeyIdCount: () => number
}

/**
 * Create (and immediately start) a key-request responder. Prefer
 * `startKeyRequestResponder` in app code — this factory exists so tests can
 * inject fakes and run isolated instances.
 */
export const createKeyRequestResponder = (deps: KeyRequestResponderDeps): KeyRequestResponder => {
  const { stageKeyring, refreshAK, fetchMetadata, now = () => Date.now(), cooldownMs = defaultCooldownMs } = deps

  const ownedChannel = deps.channel === undefined ? createBroadcastKeysSyncChannel() : null
  const channel = deps.channel !== undefined ? deps.channel : (ownedChannel?.channel ?? null)

  let active = true
  let lastKeyVersion: number | null = null
  const inflight = new Map<KeyId, Promise<void>>()
  const lastAttempts = new Map<KeyId, { action: ResponderAction; at: number }>()

  /**
   * A polled key_version strictly newer than the last one applied means the AK
   * was rotated. An unknown baseline (a key-request landing before `prime`
   * resolves) takes the stage-only branch, which is safe: `stageKeyring` refuses
   * to write a keyring the stored AK cannot open and adopts the rotated AK
   * itself.
   */
  const isVersionBump = (version: number): boolean => lastKeyVersion !== null && version > lastKeyVersion

  const recordKeyVersion = async (version: number): Promise<void> => {
    lastKeyVersion = version
    await storeKeyVersion(version)
  }

  const refreshAndAnnounce = async (): Promise<void> => {
    await refreshAK()
    channel?.postMessage({ type: 'ak-refreshed' })
  }

  /**
   * Drop attempts whose cooldown window has already elapsed. Pure memory
   * reclaim, never a refusal: `isOnCooldown` treats an entry at or past the
   * window as absent anyway, so removing it cannot change the answer for any
   * request — a legitimate user can no more be walled by this than by the
   * cooldown itself.
   *
   * It has to exist because key_ids are SERVER-SUPPLIED. `parseWireValue` now
   * keeps invented ids off this path entirely, but the grammar still admits
   * 10^15 ids, so without a sweep a malicious server (A2) could stamp rows with
   * endlessly distinct valid-looking ids and leave one permanent map entry per
   * id for the life of the page.
   */
  const pruneExpiredAttempts = (): void => {
    const cutoff = now() - cooldownMs
    for (const [keyId, attempt] of lastAttempts) {
      if (attempt.at <= cutoff) {
        lastAttempts.delete(keyId)
      }
    }
  }

  /**
   * Loop guard: if staging didn't produce the key, the codec's fail-open path
   * keeps decoding rows under it — don't re-fetch the same key_id more than once
   * per cooldown window. An `unwrap-failed` escalation may still bypass a recent
   * stage-only attempt (it upgrades the response to an AK refresh).
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
    const metadata = await fetchMetadata()
    if (reason === 'unwrap-failed' || isVersionBump(metadata.key_version)) {
      lastAttempts.set(keyId, { action: 'refresh', at: now() })
      await refreshAndAnnounce()
    } else {
      await stageKeyring()
      channel?.postMessage({ type: 'key-staged', keyId })
    }
    await recordKeyVersion(metadata.key_version)
  }

  const handleKeyRequest = (keyId: KeyId, reason: KeyRequestReason): Promise<void> => {
    pruneExpiredAttempts()
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
   * Startup staging for an already-set-up device: load the persisted key_version
   * baseline, fetch fresh metadata, and either refresh the AK (a rotation
   * happened while this device was away) or pre-stage the keyring for the worker.
   */
  const prime = async (): Promise<void> => {
    if (await needsSyncSetupWizard()) {
      return
    }
    lastKeyVersion = await getKeyVersion()
    const metadata = await fetchMetadata()
    if (isVersionBump(metadata.key_version)) {
      await refreshAndAnnounce()
    } else {
      await stageKeyring()
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
    trackedKeyIdCount: () => lastAttempts.size,
  }
}

let activeResponder: KeyRequestResponder | null = null

/**
 * Start the singleton main-thread key-request responder — called once per tab
 * from app initialization (after the authenticated HttpClient exists).
 * Idempotent across init retries: a repeat call stops the previous instance and
 * starts a fresh one with the new dependencies.
 */
export const startKeyRequestResponder = (deps: KeyRequestResponderDeps): KeyRequestResponder => {
  activeResponder?.stop()
  activeResponder = createKeyRequestResponder(deps)
  return activeResponder
}
