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
  /**
   * Current URL for this server. May change without changing `serverId` — trust domain is
   * keyed by ID, not URL. Authoritative source for runtime backend URL lookups; see
   * `getActiveCloudUrl` / `useActiveCloudUrl`. `VITE_THUNDERBOLT_CLOUD_URL` is only the
   * bootstrap default the resolver fetches `/v1/config` from on first boot.
   */
  cloudUrl: string
  /**
   * Current session's user id on this server. Populated by `SessionToRegistryMirror`
   * (see `src/contexts/auth-context.tsx`) whenever Better Auth resolves a session.
   * Persists across boots so multi-server switching (post-v1) keeps each server's
   * sign-in state intact — `activeTrustDomain` is just a pointer; the session lives
   * here.
   */
  userId?: string
  isAnonymous?: boolean
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
  /**
   * Upsert the server entry and set it as the active trust domain in a single atomic
   * update. The "upsert before set" invariant means `getActiveServerEntry()` is never
   * undefined when `activeTrustDomain.kind === 'server'`.
   */
  activateServer: (entry: ServerEntry) => void
  /** Switch to the standalone trust domain. */
  activateStandalone: () => void
  /**
   * Patch fields on the active server entry. No-op (with warning) when standalone or no
   * active domain — callers that need the patch to land must check `getActiveTrustDomain`.
   */
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

      activateServer: (entry) =>
        set((state) => ({
          servers: { ...state.servers, [entry.serverId]: { ...state.servers[entry.serverId], ...entry } },
          activeTrustDomain: { kind: 'server', serverId: entry.serverId },
        })),

      activateStandalone: () => set({ activeTrustDomain: { kind: 'standalone' } }),

      patchActiveServer: (patch) => {
        const { activeTrustDomain, servers } = get()
        if (activeTrustDomain?.kind !== 'server') {
          console.warn('[trust-domain-registry] patchActiveServer skipped — no active server', patch)
          return
        }
        const existing = servers[activeTrustDomain.serverId]
        if (!existing) {
          console.warn(
            '[trust-domain-registry] patchActiveServer skipped — active server entry missing',
            activeTrustDomain.serverId,
          )
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
 * URL of the active server, or `undefined` when standalone / no active domain.
 *
 * Authoritative source for runtime backend URL lookups (HTTP client, PowerSync connector,
 * AI provider baseURL, PostHog proxy host, ACP transport, MCP proxy, SSO redirect).
 * `VITE_THUNDERBOLT_CLOUD_URL` remains only as the bootstrap default the resolver fetches
 * `/v1/config` from on first boot.
 */
export const getActiveCloudUrl = (): string | undefined => getActiveServerEntry()?.cloudUrl

/** React-subscribing variant — re-renders consumers when the active server's URL changes. */
export const useActiveCloudUrl = (): string | undefined =>
  useTrustDomainRegistry((state) => {
    const td = state.activeTrustDomain
    if (td?.kind !== 'server') {
      return undefined
    }
    return state.servers[td.serverId]?.cloudUrl
  })

/**
 * Active user id. Returns `localUserId` in standalone, or the current session's user id
 * on the active server (real or anonymous). May be `undefined` in server mode before
 * the first sign-in completes — `SessionToRegistryMirror` populates it asynchronously.
 */
export const getActiveUserId = (): string | undefined => {
  const state = useTrustDomainRegistry.getState()
  if (state.activeTrustDomain?.kind === 'standalone') {
    return state.localUserId
  }
  return getActiveServerEntry()?.userId
}
