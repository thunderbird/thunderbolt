/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Mini App registry, fetched once per session.
 *
 * Held in a module-level store rather than component state so the sidebar and
 * the app route share one fetch and one answer — two independent fetches could
 * briefly disagree about whether an app exists, which surfaces as a Not Found
 * flashing over a page that is about to work.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { useAuth, useHttpClient } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
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

const emptyState: MiniAppsState = { apps: [], loading: true, failed: false }

let state: MiniAppsState = emptyState
let inFlight: Promise<void> | null = null
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
  inFlight ??= (async () => {
    try {
      const registry = parseMiniAppRegistry(await httpClient.get('mini-apps').json<unknown>())
      // Thrown, not folded into an empty registry: a body we can't read is the
      // `failed` case, and `body.apps ?? []` used to report it as the healthy
      // "this deployment runs no apps" — erasing the one distinction below.
      if (!registry) {
        throw new Error('GET /mini-apps did not answer with { apps: [...] }')
      }
      if (registry.dropped > 0) {
        console.error(`[mini-apps] Dropped ${registry.dropped} malformed app(s) from the registry`)
      }
      setState({ apps: registry.apps, loading: false, failed: false })
    } catch (error) {
      // Logged rather than swallowed: an empty sidebar is otherwise
      // indistinguishable from a deployment that configures no apps, and the
      // person debugging that has nothing to go on.
      console.error('[mini-apps] Could not load the registry', error)
      setState({ apps: [], loading: false, failed: true })
      // Cleared so the next mount retries, rather than the session being stuck.
      inFlight = null
    }
  })()
  return inFlight
}

export const useMiniApps = (): MiniAppsState => {
  const httpClient = useHttpClient()
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const { experimentalFeatureMiniApps } = useSettings({ experimental_feature_mini_apps: false })
  const snapshot = useSyncExternalStore(subscribe, () => state)

  /*
   * The flag gate lives here rather than at each call site.
   *
   * It was a call-site rule and the rule leaked: `useChatDestination` and
   * `MiniAppChatBanner` both mount on every signed-in session — the sidebar and
   * every `/chats/:id` — and both read the flag *after* calling this hook, so
   * `GET /mini-apps` fired on flag-off devices anyway. "A device with the
   * feature off has no registry" is one fact; stating it once is the only way
   * a new caller can't forget it.
   */
  const miniAppsEnabled = experimentalFeatureMiniApps.value

  /*
   * Only a real signed-in user has a registry to fetch.
   *
   * `GET /mini-apps` refuses anonymous sessions by design — an app that trusts
   * the identity token has no business being handed one for a synthetic
   * account. Asking anyway produced a 403 and a `console.error` on every load
   * for those users, which reads as a broken deployment rather than a feature
   * they don't have. better-auth carries `isAnonymous` loosely, so the field is
   * declared rather than cast (same pattern as `sidebar-footer.tsx`).
   */
  const sessionUser: { isAnonymous?: boolean | null } | undefined = session?.user
  const isFullUser = Boolean(sessionUser) && !sessionUser?.isAnonymous

  // Fetching an external resource on mount — the one thing effects are for.
  useEffect(() => {
    if (isPending || !isFullUser || !miniAppsEnabled) {
      return
    }
    void loadMiniApps(httpClient)
  }, [httpClient, isPending, isFullUser, miniAppsEnabled])

  /*
   * Still resolving, or nothing to load: report `loading`, never `failed`.
   * A signed-out visitor — or one with the feature off — has no registry rather
   * than a broken one, and the sidebar's failure banner would otherwise accuse
   * a healthy deployment.
   */
  if (isPending || !isFullUser || !miniAppsEnabled) {
    return emptyState
  }

  return snapshot
}
