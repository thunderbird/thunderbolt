/**
 * Auth token storage for mobile platforms (iOS/Android)
 *
 * Cookies don't persist for the tauri://localhost origin in WKWebView.
 * This module stores the session token and sends it as Authorization: Bearer header.
 *
 * Provides sync access (required by Better Auth's fetchOptions.auth.token)
 * while persisting to settings database for durability across app restarts.
 */

import { deleteSetting, getSettings, updateSettings } from '@/dal/settings'
import { isMobile } from './platform'

const AUTH_TOKEN_SETTING_KEY = 'auth_bearer_token'

let cachedToken: string | null = null

/** Get the current auth token (sync, for mobile only) */
export const getAuthToken = (): string | null => {
  if (!isMobile()) return null
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
  if (!isMobile()) return

  const settings = await getSettings({ [AUTH_TOKEN_SETTING_KEY]: String })
  cachedToken = settings.authBearerToken
}

/** Clear the auth token (for sign-out) - mobile only */
export const clearAuthToken = async (): Promise<void> => {
  if (!isMobile()) return
  await setAuthToken(null)
}
