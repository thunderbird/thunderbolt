/**
 * Auth token storage for bearer authentication
 *
 * Stores the session token in the settings database and sends it via
 * Authorization: Bearer header. Used universally across all platforms
 * for consistent authentication behavior.
 *
 * Provides sync access (required by Better Auth's fetchOptions.auth.token)
 * while persisting to settings database for durability across app restarts.
 */

import { deleteSetting, getSettings, updateSettings } from '@/dal/settings'

const AUTH_TOKEN_SETTING_KEY = 'auth_bearer_token'

let cachedToken: string | null = null

/** Get the current auth token (sync) */
export const getAuthToken = (): string | null => {
  return cachedToken
}

/** Store the auth token (cache + persist to settings) */
export const setAuthToken = async (token: string | null): Promise<void> => {
  cachedToken = token

  if (token) {
    await updateSettings({ [AUTH_TOKEN_SETTING_KEY]: token })
  } else {
    await deleteSetting(AUTH_TOKEN_SETTING_KEY)
  }
}

/** Load auth token from settings into cache (call on app init) */
export const loadAuthToken = async (): Promise<void> => {
  const settings = await getSettings({ [AUTH_TOKEN_SETTING_KEY]: String })
  cachedToken = settings.authBearerToken
}

/** Clear the auth token (for sign-out) */
export const clearAuthToken = async (): Promise<void> => {
  await setAuthToken(null)
}

/** Reset the in-memory cache (for testing only) */
export const _resetCacheForTesting = (): void => {
  cachedToken = null
}
