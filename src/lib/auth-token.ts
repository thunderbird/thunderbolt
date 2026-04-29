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

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

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
