/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Account-scoped allowlist for the iroh bridge: the trusted,
 * non-revoked device entries of the account this CLI logged in to. A logged-in bridge
 * fetches this over REST with its stored bearer, caches it in memory, and refreshes
 * it on the 45s membership heartbeat so same-account app devices are auto-trusted at the
 * gate without embedding PowerSync or ever holding the E2EE Content Key.
 *
 * This is the auto-trust *layer*, not a replacement: it sits alongside the manual
 * `iroh allow` file, which stays mandatory for another CLI's bridge identity, even on
 * the same account, and for Standalone / cross-account / CI. When the CLI has no
 * account credential (Standalone), this client is simply absent and the bridge falls
 * back to the manual file — it must never surface an error there.
 */

import { apiBaseUrl } from '../auth/config.ts'
import type { BridgeCredential } from '../auth/token-store.ts'

/** The subset of `fetch` this client uses; injected so the wire contract is
 *  unit-testable without a real network (mirrors {@link auth/http-transport}). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** An account device entry; only normal rows are admitted as peers. */
export type AllowlistEntry = {
  readonly nodeId: string
  readonly deviceType: 'normal' | 'bridge' | 'cli'
}

/** `GET /devices/allowlist` 200 body: one row per trusted, non-revoked device that
 *  has bound an iroh identity. `nodeId` is non-null in practice (the query filters
 *  `node_id IS NOT NULL`); the column is nullable, so the `string | null` type lets
 *  us narrow to `AllowlistEntry[]` with a type guard instead of an unchecked cast. */
type AllowlistRow = {
  readonly nodeId: string | null
  readonly deviceType: AllowlistEntry['deviceType']
}

/** A backend may list bridge rows apart, in `bridgeNodeIds`. They still count for
 *  self-revocation, so both arrays are read. */
type AllowlistBody = {
  readonly nodeIds: ReadonlyArray<AllowlistRow>
  readonly bridgeNodeIds?: ReadonlyArray<AllowlistRow>
}

/** Hard ceiling on the allowlist fetch. Bounds both the startup prime (which the
 *  bridge awaits before accepting any peer) and every heartbeat refresh, so a hung
 *  backend can neither block startup nor wedge the revocation loop. */
export const allowlistFetchTimeoutMs = 10_000

/** Registration failure requiring explicit tombstone removal before this persisted identity can pair again. */
export class BridgeDeviceRevokedError extends Error {
  constructor() {
    super(
      'this device was revoked on your account — remove it in Settings → Devices to pair again (manual allowlist still works)',
    )
    this.name = 'BridgeDeviceRevokedError'
  }
}

/** Build the auth header for the allowlist fetch from the credential's wire scheme:
 *  a device-grant session authenticates via `Authorization: Bearer`, while a Better
 *  Auth api key / PAT authenticates via `x-api-key` (the apiKey plugin reads ONLY
 *  that header — sending it as a bearer would silently 401). */
const authHeader = (credential: BridgeCredential): Record<string, string> =>
  credential.kind === 'apiKey' ? { 'x-api-key': credential.token } : { authorization: `Bearer ${credential.token}` }

/**
 * Fetch the caller account's device entries from the backend. Credential-scoped to
 * the account, so it only ever returns same-account rows. Aborts after `timeoutMs`
 * and throws on abort or a non-2xx response, so the caller's refresh boundary can
 * decide whether to soft-fail.
 *
 * @param credential - the bridge credential (token + backend + wire scheme)
 * @param fetchFn - HTTP fetch (defaults to the global `fetch`)
 * @param timeoutMs - abort deadline (default {@link allowlistFetchTimeoutMs})
 * @returns the account's listed device entries
 */
export const fetchAccountAllowlist = async (
  credential: BridgeCredential,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = allowlistFetchTimeoutMs,
): Promise<AllowlistEntry[]> => {
  const res = await fetchFn(`${apiBaseUrl(credential.cloudUrl)}/devices/allowlist`, {
    headers: authHeader(credential),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`account allowlist fetch failed (${res.status} ${res.statusText})`)
  }
  const body = (await res.json()) as AllowlistBody
  return [...body.nodeIds, ...(body.bridgeNodeIds ?? [])].filter((row): row is AllowlistEntry => Boolean(row.nodeId))
}

/**
 * Register this bridge's bare NodeId with its account before fetching account
 * trust. Throws an actionable revoked error on 409, preserves the legacy 403 error,
 * and throws on every other failed response or network error so the bridge startup
 * boundary can disable auto-trust.
 *
 * @param credential - bridge credential and backend URL
 * @param nodeId - bridge's bare iroh NodeId
 * @param name - account-visible bridge device name
 * @param fetchFn - HTTP fetch (defaults to global `fetch`)
 * @param timeoutMs - abort deadline (default {@link allowlistFetchTimeoutMs})
 */
export const registerBridgeWithBackend = async (
  credential: BridgeCredential,
  nodeId: string,
  name: string,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = allowlistFetchTimeoutMs,
): Promise<void> => {
  const res = await fetchFn(`${apiBaseUrl(credential.cloudUrl)}/devices/bridge`, {
    method: 'POST',
    headers: { ...authHeader(credential), 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, name }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 409) throw new BridgeDeviceRevokedError()
  if (res.status === 403) throw new Error('bridge revoked on the account')
  if (!res.ok) throw new Error(`bridge registration failed (${res.status} ${res.statusText})`)
}

/** An in-memory account allowlist: membership check + a re-fetch that swaps the cache. */
export type AccountAllowlist = {
  /** Whether `nodeId` is trusted: a normal device in the last successfully-fetched account
   *  allowlist AND this bridge is not itself self-revoked ({@link isSelfRevoked}).
   *  A self-revoked bridge trusts no account peer (auto-trust off); the manual file
   *  still governs at the gate. */
  readonly has: (nodeId: string) => boolean
  /** Re-fetch and replace the cache. Soft-fails: a transient fetch error keeps the
   *  last-known-good set (a network blip must not tear down every same-account peer)
   *  and is logged, never thrown — the manual file still governs regardless. */
  readonly refresh: () => Promise<void>
  /** Whether this bridge's own NodeId has dropped out of a *populated* account
   *  allowlist — i.e. the account revoked this device, nulling its node_id and
   *  removing it from the list. An empty `listed` set is "unknown" (unprimed /
   *  fetch failed), never a revocation, so a transient outage can't disable
   *  auto-trust. While true, {@link has} trusts nobody. */
  readonly isSelfRevoked: () => boolean
}

/**
 * Build an {@link AccountAllowlist} over an injected device-row fetcher. Starts from
 * `initialEntries` when startup already fetched a successful prime, or empty so no
 * peer is auto-trusted before the first successful {@link AccountAllowlist.refresh}.
 *
 * Self-revocation: the bridge's own NodeId is one of the account's trusted
 * devices, so it normally appears in the fetched list. If a *populated* refresh omits
 * it, the account has revoked this bridge — {@link AccountAllowlist.has} then trusts
 * nobody, so both the connection gate and the heartbeat re-check drop every
 * same-account peer within one interval. The manual `iroh allow` file is unaffected.
 *
 * @param fetchEntries - fetches the account's listed device entries (the network seam)
 * @param selfNodeId - this bridge's own NodeId, checked for self-revocation
 * @param initialEntries - successfully fetched startup prime
 */
export const createAccountAllowlist = (
  fetchEntries: () => Promise<AllowlistEntry[]>,
  selfNodeId: string,
  initialEntries: ReadonlyArray<AllowlistEntry> = [],
): AccountAllowlist => {
  const self = selfNodeId.trim()
  // Bridge rows track self-revocation; only normal app devices qualify for automatic
  // peer admission.
  const toSets = (entries: ReadonlyArray<AllowlistEntry>) => {
    const listed = new Set<string>()
    const peers = new Set<string>()
    for (const entry of entries) {
      const nodeId = entry.nodeId.trim()
      if (!nodeId) continue
      listed.add(nodeId)
      if (entry.deviceType === 'normal') peers.add(nodeId)
    }
    return { listed, peers }
  }
  let cached = toSets(initialEntries)
  const isSelfRevoked = (): boolean => cached.listed.size > 0 && !cached.listed.has(self)
  return {
    has: (nodeId) => !isSelfRevoked() && cached.peers.has(nodeId.trim()),
    isSelfRevoked,
    refresh: async () => {
      try {
        cached = toSets(await fetchEntries())
      } catch (err) {
        process.stderr.write(
          `⚡ iroh bridge: account allowlist refresh failed, keeping last-known set: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    },
  }
}
