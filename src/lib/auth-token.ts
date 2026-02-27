/**
 * Auth token storage for bearer authentication.
 *
 * Token is stored in localStorage so getAuthToken() is sync (required by Better Auth).
 * device_id is also in localStorage to identify this device (e.g. for PowerSync / devices list).
 *
 * Falls back to in-memory storage when localStorage is unavailable (e.g., insecure context).
 *
 * TODO: once we have a proper encryption middleware, we should store the auth token in the settings database.
 */

const DEVICE_ID_KEY = 'thunderbolt_device_id'
const AUTH_TOKEN_KEY = 'thunderbolt_auth_token'

/** In-memory fallback when localStorage is unavailable */
const memoryStorage = new Map<string, string>()

const isLocalStorageAvailable = (): boolean => {
  try {
    const test = '__storage_test__'
    localStorage.setItem(test, test)
    localStorage.removeItem(test)
    return true
  } catch {
    return false
  }
}

const safeGetItem = (key: string): string | null => {
  try {
    if (isLocalStorageAvailable()) {
      return localStorage.getItem(key)
    }
  } catch {
    // Fall through to memory storage
  }
  return memoryStorage.get(key) ?? null
}

const safeSetItem = (key: string, value: string): void => {
  try {
    if (isLocalStorageAvailable()) {
      localStorage.setItem(key, value)
      return
    }
  } catch {
    // Fall through to memory storage
  }
  memoryStorage.set(key, value)
}

const safeRemoveItem = (key: string): void => {
  try {
    if (isLocalStorageAvailable()) {
      localStorage.removeItem(key)
      return
    }
  } catch {
    // Fall through to memory storage
  }
  memoryStorage.delete(key)
}

/** Get or create device_id (from localStorage or memory fallback). */
export const getDeviceId = (): string => {
  let id = safeGetItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    safeSetItem(DEVICE_ID_KEY, id)
  }
  return id
}

/** Get the current auth token (sync, from localStorage or memory fallback). */
export const getAuthToken = (): string | null => safeGetItem(AUTH_TOKEN_KEY)

/** Store the auth token in localStorage or memory fallback. Use clearAuthToken() to remove. */
export const setAuthToken = (token: string): void => {
  safeSetItem(AUTH_TOKEN_KEY, token)
}

/** Clear the auth token (for sign-out). */
export const clearAuthToken = (): void => {
  safeRemoveItem(AUTH_TOKEN_KEY)
}
