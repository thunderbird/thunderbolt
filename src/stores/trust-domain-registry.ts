/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v7 as uuidv7 } from 'uuid'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Trust-domain registry — single source of truth for "which servers does this device
 * know about, which one is active, and what's the per-server identity material."
 *
 * Per-server resources (auth token, device id, encryption-key IDB DB, DB filename)
 * are namespaced by `serverId`, so the v1 single-server shape is also the N-server
 * shape — no second migration when multi-server UI ships.
 *
 * Stored at `localStorage['thunderbolt-trust-domains-v1']`.
 */

export type StandaloneTrustDomain = { kind: 'standalone' }
export type ServerTrustDomain = { kind: 'server'; serverId: string }
export type ActiveTrustDomain = StandaloneTrustDomain | ServerTrustDomain

export type ServerEntry = {
  /** Stable per-deployment UUID returned by `GET /v1/config`. Registry key. */
  serverId: string
  /** Current URL for this server. May change without changing `serverId` — trust domain is keyed by ID, not URL. */
  cloudUrl: string
  lastUserId?: string
  lastUserIsAnonymous?: boolean
}

type TrustDomainState = {
  servers: Record<string, ServerEntry>
  /**
   * Generated once on first registry hydration via `crypto.randomUUID()` and persisted
   * for device life. Used as `user_id` in standalone trust domains; harmless to pre-create
   * before standalone is ever entered.
   */
  localUserId: string
  /**
   * Resolved by the boot decision tree (`useAppInitialization` in commit 3). After boot it's
   * never null at runtime; consumers reading it before boot must tolerate `undefined`.
   */
  activeTrustDomain?: ActiveTrustDomain
}

type TrustDomainActions = {
  setActiveTrustDomain: (domain: ActiveTrustDomain) => void
  upsertServer: (entry: ServerEntry) => void
  patchActiveServer: (patch: Partial<Omit<ServerEntry, 'serverId'>>) => void
}

type TrustDomainStore = TrustDomainState & TrustDomainActions

const storageName = 'thunderbolt-trust-domains-v1'

const createLocalUserId = (): string => uuidv7()

export const useTrustDomainRegistry = create<TrustDomainStore>()(
  persist(
    (set, get) => ({
      servers: {},
      localUserId: createLocalUserId(),
      activeTrustDomain: undefined,

      setActiveTrustDomain: (activeTrustDomain) => set({ activeTrustDomain }),

      upsertServer: (entry) =>
        set((state) => ({
          servers: { ...state.servers, [entry.serverId]: { ...state.servers[entry.serverId], ...entry } },
        })),

      patchActiveServer: (patch) => {
        const { activeTrustDomain, servers } = get()
        if (activeTrustDomain?.kind !== 'server') {
          return
        }
        const existing = servers[activeTrustDomain.serverId]
        if (!existing) {
          return
        }
        set({ servers: { ...servers, [activeTrustDomain.serverId]: { ...existing, ...patch } } })
      },
    }),
    {
      name: storageName,
      // Listed explicitly (rather than spread + omit) so TS errors if a new
      // TrustDomainState field is added without persisting it.
      partialize: (s): TrustDomainState => ({
        servers: s.servers,
        localUserId: s.localUserId,
        activeTrustDomain: s.activeTrustDomain,
      }),
      onRehydrateStorage: () => (state) => {
        // Old installs predate this store entirely (state === undefined); the create()
        // initializer already minted a localUserId. Fresh installs reach this with the
        // initializer's localUserId intact. The only case we patch here is a persisted
        // state that somehow lost its localUserId — e.g. a partially-corrupted entry.
        if (state && !state.localUserId) {
          state.localUserId = createLocalUserId()
        }
      },
    },
  ),
)

// =============================================================================
// Sync getters for non-React consumers (HTTP client, PowerSync connector, DAL).
// =============================================================================

export const getRegistry = (): TrustDomainState => useTrustDomainRegistry.getState()

export const getActiveTrustDomain = (): ActiveTrustDomain | undefined =>
  useTrustDomainRegistry.getState().activeTrustDomain

/** Active server entry, or `undefined` when standalone / no active domain. */
export const getActiveServerEntry = (): ServerEntry | undefined => {
  const { activeTrustDomain, servers } = useTrustDomainRegistry.getState()
  if (activeTrustDomain?.kind !== 'server') {
    return undefined
  }
  return servers[activeTrustDomain.serverId]
}

/** Active server's stable id, or `undefined` when standalone / no active domain. */
export const getActiveServerId = (): string | undefined => {
  const activeTrustDomain = useTrustDomainRegistry.getState().activeTrustDomain
  return activeTrustDomain?.kind === 'server' ? activeTrustDomain.serverId : undefined
}

/**
 * Active user id. Returns `localUserId` in standalone, the last-known session user id
 * in server mode (real or anonymous). May be `undefined` in server mode before the
 * first sign-in completes.
 */
export const getActiveUserId = (): string | undefined => {
  const state = useTrustDomainRegistry.getState()
  if (state.activeTrustDomain?.kind === 'standalone') {
    return state.localUserId
  }
  return getActiveServerEntry()?.lastUserId
}
