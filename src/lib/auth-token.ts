/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auth token + device id storage. Both are localStorage-backed so reads are sync
 * (Better Auth, PowerSync connector, HTTP client all need sync access).
 *
 * Keys are namespaced by the active server's `serverId` — so multiple servers can
 * coexist on the same device without leaking credentials across trust domains.
 * In standalone mode (or before the boot decision tree resolves), there is no
 * active server and these helpers are no-ops / return empty.
 *
 * TODO: once we have a proper encryption middleware, we should store the auth token in the settings database.
 */

import { v7 as uuidv7 } from 'uuid'
import { getActiveServerId } from '@/stores/trust-domain-registry'
import { getDeviceDisplayName } from '@/lib/platform'

const authTokenPrefix = 'thunderbolt_auth_token__'
const deviceIdPrefix = 'thunderbolt_device_id__'

const authTokenKeyFor = (serverId: string): string => `${authTokenPrefix}${serverId}`
const deviceIdKeyFor = (serverId: string): string => `${deviceIdPrefix}${serverId}`

/**
 * Get or create a device_id for the active server. Returns an empty string when no
 * server is active — callers that filter falsy values (e.g. header builders) skip
 * the device headers cleanly in that case.
 */
export const getDeviceId = (): string => {
  const serverId = getActiveServerId()
  if (!serverId) {
    return ''
  }
  const key = deviceIdKeyFor(serverId)
  const existing = localStorage.getItem(key)
  if (existing) {
    return existing
  }
  const id = uuidv7()
  localStorage.setItem(key, id)
  return id
}

// Scoped override consulted before the registry-derived lookup. The sign-out
// wipe sequence empties `activeTrustDomain` before calling Better Auth's
// `signOut()`, so the normal `getActiveServerId()` resolution would return
// `null` and the sign-out request would go out bearer-less. `withCapturedAuthToken`
// replays the pre-wipe token for the duration of that call.
let capturedAuthToken: string | null = null

/** Get the active server's auth token, or null if there is no active server / not signed in. */
export const getAuthToken = (): string | null => {
  if (capturedAuthToken !== null) {
    return capturedAuthToken
  }
  const serverId = getActiveServerId()
  if (!serverId) {
    return null
  }
  return localStorage.getItem(authTokenKeyFor(serverId))
}

/**
 * Run `fn` with `getAuthToken()` short-circuited to return `token`. Used by
 * `signOutAndWipe` so the sign-out HTTP call stays authenticated even though
 * `clearLocalData` has already cleared `activeTrustDomain` from the registry
 * by the time signOut runs.
 */
export const withCapturedAuthToken = async <T>(token: string | null, fn: () => Promise<T>): Promise<T> => {
  const prev = capturedAuthToken
  capturedAuthToken = token
  try {
    return await fn()
  } finally {
    capturedAuthToken = prev
  }
}

/** Store the auth token under the active server's namespace. No-op when no server is active. */
export const setAuthToken = (token: string): void => {
  const serverId = getActiveServerId()
  if (!serverId) {
    return
  }
  localStorage.setItem(authTokenKeyFor(serverId), token)
}

/**
 * Clear the auth token. Defaults to the active server (registry-resolved), but
 * the wipe path passes the captured serverId explicitly because cleanup.ts
 * clears `activeTrustDomain` from the registry before this runs (so the
 * default would resolve to undefined and no-op).
 */
export const clearAuthToken = (serverId?: string): void => {
  const id = serverId ?? getActiveServerId()
  if (!id) {
    return
  }
  localStorage.removeItem(authTokenKeyFor(id))
}

/** Same shape as `clearAuthToken` — explicit serverId for callers running after a registry clear. */
export const clearDeviceId = (serverId?: string): void => {
  const id = serverId ?? getActiveServerId()
  if (!id) {
    return
  }
  localStorage.removeItem(deviceIdKeyFor(id))
}

/**
 * Build authenticated headers (Authorization + device identity).
 * Single source of truth for callers that cannot use the HTTP client (e.g. PowerSync connector).
 */
export const getAuthenticatedHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const deviceId = getDeviceId()
  if (deviceId) {
    headers['X-Device-ID'] = deviceId
    headers['X-Device-Name'] = getDeviceDisplayName()
  }
  if (import.meta.env.VITE_APP_VERSION) {
    headers['X-App-Version'] = import.meta.env.VITE_APP_VERSION
  }
  return headers
}

/**
 * Subscribe to auth token changes originating in a different browser tab for the active server.
 *
 * The `storage` event only fires in tabs OTHER than the one that wrote the value, making
 * it the correct mechanism for cross-tab coordination. The active server is re-resolved
 * on every event so a server switch (post-v1) doesn't leave dangling listeners.
 *
 * @returns Unsubscribe function — call on component unmount.
 */
export const onAuthTokenChangedInOtherTab = (
  listener: (next: string | null, prev: string | null) => void,
): (() => void) => {
  const handler = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) {
      return
    }
    const serverId = getActiveServerId()
    if (!serverId || event.key !== authTokenKeyFor(serverId)) {
      return
    }

    const next = event.newValue
    const prev = event.oldValue

    // Skip same-value writes (no real change).
    if (next === prev) {
      return
    }

    // If the incoming value is empty/falsy but our own token is still present, the event is
    // legitimate (another tab signed out) — fire the listener once. We do NOT suppress this
    // case; the listener decides how to react.
    listener(next, prev)
  }

  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
