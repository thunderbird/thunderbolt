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
import { getAuthenticatedHeaders } from '@/lib/auth-token'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { toMiniAppDefinition, type MiniAppDefinition, type MiniAppResponse } from './registry'

export type MiniAppsState = {
  apps: MiniAppDefinition[]
  /** True until the first fetch settles, so a route can wait instead of 404ing. */
  loading: boolean
}

const emptyState: MiniAppsState = { apps: [], loading: true }

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
 * Load the registry, at most once.
 *
 * A failure resolves to an empty registry rather than retrying: the sidebar
 * simply shows no apps, which is the same thing a deployment with none
 * configured looks like, and is far better than a nav section that flickers.
 */
const loadMiniApps = (cloudUrl: string): Promise<void> => {
  inFlight ??= (async () => {
    const response = await fetch(`${cloudUrl}/mini-apps`, {
      headers: getAuthenticatedHeaders(),
      credentials: 'include',
    }).catch(() => null)

    const body = response?.ok
      ? ((await response.json().catch(() => null)) as { apps?: MiniAppResponse[] } | null)
      : null
    setState({ apps: (body?.apps ?? []).map(toMiniAppDefinition), loading: false })
  })()
  return inFlight
}

/** Drop the cached registry — used by tests, and by sign-out. */
export const resetMiniApps = () => {
  state = emptyState
  inFlight = null
  listeners.forEach((listener) => listener())
}

export const useMiniApps = (): MiniAppsState => {
  const cloudUrl = useLocalSettingsStore((settings) => settings.cloudUrl)
  const snapshot = useSyncExternalStore(subscribe, () => state)

  // Fetching an external resource on mount — the one thing effects are for.
  useEffect(() => {
    if (cloudUrl) {
      void loadMiniApps(cloudUrl)
    }
  }, [cloudUrl])

  return snapshot
}
