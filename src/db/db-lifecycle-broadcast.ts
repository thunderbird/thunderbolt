/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getActiveTrustDomain, type ActiveTrustDomain } from '@/stores/trust-domain-registry'

/**
 * Cross-tab DB lifecycle coordination.
 *
 * When the active trust domain's SQLite file is about to be closed or has been deleted,
 * every tab needs to know — a stale DB handle in another tab will fail mid-write once
 * the file is gone. Mirrors the existing `thunderbolt-ck-invalidation` pattern in
 * `src/db/encryption/codec.ts`.
 *
 * Producer: the logout / wipe flow (`clearLocalData`) broadcasts `db-closing` then
 * `db-deleted`.
 *
 * Consumer: the listener installed by `setupDbLifecycleReloadOnRemoteClose` reloads the
 * window when another tab signals a close/delete for *this* tab's active trust domain.
 * Messages for a different trust domain are ignored — N-server-ready.
 */

const channelName = 'thunderbolt-db-lifecycle'

export type DbLifecycleEvent =
  | { kind: 'db-closing'; trustDomain: ActiveTrustDomain }
  | { kind: 'db-deleted'; trustDomain: ActiveTrustDomain }

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : null

/** Post a lifecycle event to all other tabs. No-op in environments without BroadcastChannel. */
export const broadcastDbLifecycle = (event: DbLifecycleEvent): void => {
  channel?.postMessage(event)
}

const isSameTrustDomain = (a: ActiveTrustDomain, b: ActiveTrustDomain): boolean => {
  if (a.kind === 'standalone') {
    return b.kind === 'standalone'
  }
  return b.kind === 'server' && a.serverId === b.serverId
}

let reloadListenerInstalled = false

/**
 * Idempotent installer for the "remote tab closed our DB → reload" behavior. Safe to call
 * on every boot/retry — the listener is installed once for the lifetime of the page.
 * No-op when BroadcastChannel is unavailable (e.g. some test environments).
 */
export const setupDbLifecycleReloadOnRemoteClose = (): void => {
  if (reloadListenerInstalled || !channel) {
    return
  }
  reloadListenerInstalled = true
  channel.addEventListener('message', (event: MessageEvent<DbLifecycleEvent>) => {
    const active = getActiveTrustDomain()
    if (!active || !isSameTrustDomain(active, event.data.trustDomain)) {
      return
    }
    console.info(`[db-lifecycle] received ${event.data.kind} from another tab — reloading`)
    window.location.reload()
  })
}
