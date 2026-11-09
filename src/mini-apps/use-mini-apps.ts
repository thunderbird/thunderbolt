/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Mini App registry, fetched once per identity.
 *
 * Held in a module-level store rather than component state so the sidebar and
 * the app route share one fetch and one answer — two independent fetches could
 * briefly disagree about whether an app exists, which surfaces as a Not Found
 * flashing over a page that is about to work.
 *
 * `GET /mini-apps` works without a session and carries no secret, so every
 * caller resolves to the same two terminal states — apps, or none. There is no
 * third "you may not ask" state to model, which is what used to leave
 * `/apps/:id` on `loading` forever for anonymous and signed-out callers. The
 * answer can still depend on the caller: an app with `allowedEmails` is only
 * listed for the users on it. So the list is fetched again when the signed-in
 * user changes (see {@link syncMiniAppsUser}), not once per page session.
 *
 * Every path out of `loading` is now bounded. Removing the auth gate fixed the
 * cases where we *chose* not to ask; it left the case where we ask and are never
 * answered, and an accepted-but-unanswered request kept `loading` true forever —
 * which `MiniAppPage` renders as a permanently blank screen with nothing logged.
 * Hence the deadline below.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { useAuth, useHttpClient } from '@/contexts'
import type { HttpClient } from '@/lib/http'
import { parseMiniAppRegistry, type MiniAppDefinition } from './registry'

export type MiniAppsState = {
  apps: MiniAppDefinition[]
  /** True until the first fetch settles, so a route can wait instead of 404ing. */
  loading: boolean
  /**
   * The fetch failed, as distinct from succeeding with nothing configured.
   *
   * Callers need to tell those apart. An empty registry means "this deployment
   * runs no apps"; a failed one means we don't know — and saying "that app is
   * no longer available" about a perfectly healthy deployment, on every chat
   * that came from it, is worse than saying nothing.
   */
  failed: boolean
}

/**
 * How long to wait for the registry before calling the deployment unreachable.
 *
 * `HttpClient` only applies a timeout when asked, and nothing else bounds this
 * request: a server that accepts the connection and never answers leaves the
 * whole feature on `loading`, which renders as a blank `/apps/:id`. Generous,
 * because the answer gates a route rather than a keystroke — but finite, because
 * "we don't know yet" is not a state the UI can sit in indefinitely.
 */
export const registryTimeoutMs = 10_000

const emptyState: MiniAppsState = { apps: [], loading: true, failed: false }

let state: MiniAppsState = emptyState
let inFlight: Promise<void> | null = null
/**
 * Which era of the store a load belongs to.
 *
 * Advanced when the signed-in user changes, so a request still in flight for the
 * previous identity cannot land its answer over the new one's, and by
 * {@link resetMiniAppsForTesting}: without that, a load started by one test file
 * could still be in flight when the next file resets the store, and its
 * `setState` would land afterwards. That made two tests here fail roughly one
 * randomized run in four, which is exactly the kind of flake nobody can
 * reproduce on demand.
 */
let generation = 0
const listeners = new Set<() => void>()

const setState = (next: MiniAppsState) => {
  state = next
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Load the registry.
 *
 * Deduped while in flight so the sidebar and the route share one request, but
 * *not* cached across failures: holding `inFlight` after a rejection meant one
 * transient 502 at startup left the tab with no apps for the rest of its life,
 * and no way to recover short of a reload.
 */
const loadMiniApps = (httpClient: HttpClient): Promise<void> => {
  const era = generation
  inFlight ??= (async () => {
    try {
      const registry = parseMiniAppRegistry(
        await httpClient.get('mini-apps', { timeout: registryTimeoutMs }).json<unknown>(),
      )
      // Thrown, not folded into an empty registry: a body we can't read is the
      // `failed` case, and `body.apps ?? []` used to report it as the healthy
      // "this deployment runs no apps" — erasing the one distinction below.
      if (!registry) {
        throw new Error('GET /mini-apps did not answer with { apps: [...] }')
      }
      if (registry.dropped > 0) {
        console.error(`[mini-apps] Dropped ${registry.dropped} malformed app(s) from the registry`)
      }
      if (era !== generation) {
        return
      }
      setState({ apps: registry.apps, loading: false, failed: false })
    } catch (error) {
      // Logged rather than swallowed: an empty sidebar is otherwise
      // indistinguishable from a deployment that configures no apps, and the
      // person debugging that has nothing to go on.
      console.error('[mini-apps] Could not load the registry', error)
      if (era !== generation) {
        return
      }
      // Never keeps the previous list: after an identity change it belongs to
      // someone else, and showing it would be showing the wrong user's apps.
      setState({ apps: [], loading: false, failed: true })
      // Cleared so the next mount retries, rather than the session being stuck.
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * The identity the current registry was fetched for: a user id, `null` for
 * signed out, `undefined` until a session settles.
 */
let registryIdentity: string | null | undefined

/**
 * Fetch again when the signed-in identity changes, including signing out.
 *
 * The registry depends on who is asking: an app with `allowedEmails` is left
 * out for an anonymous session, and the in-tab sign-in modal turns that session
 * into a real one without a reload. Keyed on the user id rather than on the
 * modal's success event, so it also fires when the modal is dismissed after the
 * code was accepted. The list on screen stays while the refetch is in flight;
 * if that fails the store drops to `failed`. Advancing the era drops any request
 * still in flight for the old identity.
 *
 * `undefined` means the session has not settled and is ignored. The first
 * settled identity is recorded without a refetch: the initial load already
 * covers it.
 */
export const syncMiniAppsUser = (identity: string | null | undefined, httpClient: HttpClient) => {
  if (identity === undefined || identity === registryIdentity) {
    return
  }
  const isFirstIdentity = registryIdentity === undefined
  registryIdentity = identity
  if (isFirstIdentity) {
    return
  }
  generation += 1
  inFlight = null
  void loadMiniApps(httpClient)
}

/**
 * Keeps the registry in step with the session. Mount once at app level, so every
 * reader of the store is covered at every width; `useMiniApps` consumers stay
 * free of auth.
 */
export const useMiniAppsUserSync = () => {
  const httpClient = useHttpClient()
  const { data: session, isPending } = useAuth().useSession()
  const identity = isPending ? undefined : (session?.user?.id ?? null)
  useEffect(() => {
    syncMiniAppsUser(identity, httpClient)
  }, [identity, httpClient])
}

/**
 * @internal Reset the module store between tests.
 *
 * The store is module-level so the sidebar and the route share one answer, which
 * also means a test that drives it leaks into every later file in the process.
 * Same shape as `resetAppVersionBlockedForTesting`.
 */
export const resetMiniAppsForTesting = () => {
  generation += 1
  state = emptyState
  inFlight = null
  registryIdentity = undefined
  listeners.clear()
}

export const useMiniApps = (): MiniAppsState => {
  const httpClient = useHttpClient()
  const snapshot = useSyncExternalStore(subscribe, () => state)

  // Fetching an external resource on mount — the one thing effects are for.
  useEffect(() => {
    void loadMiniApps(httpClient)
  }, [httpClient])

  return snapshot
}
