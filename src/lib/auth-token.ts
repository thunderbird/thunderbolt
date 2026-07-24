/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auth token storage for bearer authentication.
 *
 * Token is stored in localStorage so getAuthToken() is sync (required by Better Auth).
 * device_id is also in localStorage to identify this device (e.g. for PowerSync / devices list).
 *
 * TODO: once we have a proper encryption middleware, we should store the auth token in the settings database.
 */

import { getDeviceDisplayName } from '@/lib/platform'

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const userCacheSecretKey = 'thunderbolt_user_cache_secret'

/** Get or create device_id (from localStorage). */
export const getDeviceId = (): string => {
  let id = localStorage.getItem(deviceIdKey)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(deviceIdKey, id)
  }
  return id
}

/** Get the current auth token (sync, from localStorage). */
export const getAuthToken = (): string | null => localStorage.getItem(authTokenKey)

/** Store the auth token in localStorage. Use clearAuthToken() to remove. */
export const setAuthToken = (token: string): void => {
  localStorage.setItem(authTokenKey, token)
}

/** Clear the auth token (for sign-out). */
export const clearAuthToken = (): void => {
  localStorage.removeItem(authTokenKey)
}

/** Clear the device ID (for revoked devices — forces a new ID on next login). */
export const clearDeviceId = (): void => {
  localStorage.removeItem(deviceIdKey)
}

/**
 * Get or create the Tinfoil prompt-cache secret (from localStorage).
 * Per-device, never synced (THU-708). Distinct from the device ID: it must
 * only reach the attested enclave, never our backend.
 */
export const getUserCacheSecret = (): string => {
  const existing = localStorage.getItem(userCacheSecretKey)
  if (existing) {
    return existing
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  localStorage.setItem(userCacheSecretKey, secret)
  return secret
}

/** Clear the prompt-cache secret (identity teardown — forces a new cache namespace). */
export const clearUserCacheSecret = (): void => {
  localStorage.removeItem(userCacheSecretKey)
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
 * Subscribe to auth token changes originating in a different browser tab.
 *
 * The `storage` event only fires in tabs OTHER than the one that wrote the value, making
 * it the correct mechanism for cross-tab coordination.
 *
 * @returns Unsubscribe function — call on component unmount.
 */
export const onAuthTokenChangedInOtherTab = (
  listener: (next: string | null, prev: string | null) => void,
): (() => void) => {
  const handler = (event: StorageEvent) => {
    if (event.storageArea !== localStorage || event.key !== authTokenKey) {
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
