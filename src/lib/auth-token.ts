/**
 * Auth token storage for bearer authentication.
 *
 * Token is stored in localStorage so getAuthToken() is sync (required by Better Auth).
 * device_id is also in localStorage to identify this device (e.g. for PowerSync / devices list).
 *
 * TODO: once we have a proper encryption middleware, we should store the auth token in the settings database.
 */

const DEVICE_ID_KEY = 'thunderbolt_device_id'
const AUTH_TOKEN_KEY = 'thunderbolt_auth_token'

/** Get or create device_id (from localStorage). */
export const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

/** Get the current auth token (sync, from localStorage). */
export const getAuthToken = (): string | null => localStorage.getItem(AUTH_TOKEN_KEY)

/** Store the auth token in localStorage. Use clearAuthToken() to remove. */
export const setAuthToken = (token: string): void => {
  localStorage.setItem(AUTH_TOKEN_KEY, token)
}

/** Clear the auth token (for sign-out). */
export const clearAuthToken = (): void => {
  localStorage.removeItem(AUTH_TOKEN_KEY)
}
