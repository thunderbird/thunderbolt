/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Account-scoped allowlist for the iroh bridge (design decision D2): the trusted,
 * non-revoked NodeIds of the account this CLI logged in to. A logged-in bridge
 * fetches this over REST with its stored bearer, caches it in memory, and refreshes
 * it on the 45s membership heartbeat — so same-account peers are auto-trusted at the
 * gate without embedding PowerSync or ever holding the E2EE Content Key.
 *
 * This is the auto-trust *layer*, not a replacement: it sits alongside the manual
 * `iroh allow` file, which stays mandatory for Standalone / cross-account / CI. When
 * the CLI has no account credential (Standalone), this client is simply absent and
 * the bridge falls back to the manual file — it must never surface an error there.
 */

/** The subset of `fetch` this client uses; injected so the wire contract is
 *  unit-testable without a real network (mirrors {@link auth/http-transport}). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** `GET /devices/allowlist` 200 body: one row per trusted, non-revoked device that
 *  has bound an iroh identity. `nodeId` is non-null in practice (the query filters
 *  `node_id IS NOT NULL`); the column is nullable, so the `string | null` type lets
 *  us narrow to `string[]` with a type guard instead of an unchecked cast. */
type AllowlistBody = { readonly nodeIds: ReadonlyArray<{ readonly nodeId: string | null }> }

/** Hard ceiling on the allowlist fetch. Bounds both the startup prime (which the
 *  bridge awaits before accepting any peer) and every heartbeat refresh, so a hung
 *  backend can neither block startup nor wedge the revocation loop. */
export const ALLOWLIST_FETCH_TIMEOUT_MS = 10_000

/**
 * Fetch the caller account's trusted NodeIds from the backend. Bearer-scoped to the
 * account, so it only ever returns same-account rows. Aborts after `timeoutMs` and
 * throws on abort or a non-2xx response, so the caller's refresh boundary can decide
 * whether to soft-fail.
 *
 * @param cloudUrl - the `…/v1` backend base the credential belongs to
 * @param token - the signed account bearer minted by `thunderbolt login`
 * @param fetchFn - HTTP fetch (defaults to the global `fetch`)
 * @param timeoutMs - abort deadline (default {@link ALLOWLIST_FETCH_TIMEOUT_MS})
 * @returns the account's trusted NodeId strings
 */
export const fetchAccountAllowlist = async (
  cloudUrl: string,
  token: string,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = ALLOWLIST_FETCH_TIMEOUT_MS,
): Promise<string[]> => {
  const res = await fetchFn(`${cloudUrl.replace(/\/+$/, '')}/devices/allowlist`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`account allowlist fetch failed (${res.status} ${res.statusText})`)
  }
  const body = (await res.json()) as AllowlistBody
  return body.nodeIds.map((row) => row.nodeId).filter((id): id is string => Boolean(id))
}

/** An in-memory account allowlist: membership check + a re-fetch that swaps the cache. */
export type AccountAllowlist = {
  /** Whether `nodeId` is in the last successfully-fetched account allowlist. */
  readonly has: (nodeId: string) => boolean
  /** Re-fetch and replace the cache. Soft-fails: a transient fetch error keeps the
   *  last-known-good set (a network blip must not tear down every same-account peer)
   *  and is logged, never thrown — the manual file still governs regardless. */
  readonly refresh: () => Promise<void>
}

/**
 * Build an {@link AccountAllowlist} over an injected NodeId fetcher. Starts empty
 * (no peer auto-trusted until the first successful {@link AccountAllowlist.refresh}),
 * so a failed prime falls back safely to the manual file rather than trusting anyone.
 *
 * @param fetchNodeIds - fetches the account's trusted NodeIds (the network seam)
 */
export const createAccountAllowlist = (fetchNodeIds: () => Promise<string[]>): AccountAllowlist => {
  let trusted = new Set<string>()
  return {
    has: (nodeId) => trusted.has(nodeId.trim()),
    refresh: async () => {
      try {
        const ids = await fetchNodeIds()
        trusted = new Set(ids.map((id) => id.trim()).filter(Boolean))
      } catch (err) {
        process.stderr.write(
          `⚡ iroh bridge: account allowlist refresh failed, keeping last-known set: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    },
  }
}
