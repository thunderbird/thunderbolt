import { isTauri } from '@/lib/platform'

/**
 * Determines the correct OAuth redirect URI based on the platform
 *
 * - Web: Uses the web callback route at the current origin
 * - Tauri (desktop + mobile): Uses https://thunderbolt.io/oauth/callback
 *   Desktop intercepts via tauri://navigate before the URL loads.
 *   Mobile intercepts via App Link / Universal Link.
 *
 * @returns The appropriate redirect URI for the current platform
 */
export const getOAuthRedirectUri = (): string => {
  if (!isTauri()) {
    return window.location.origin + '/oauth/callback'
  }

  return 'https://thunderbolt.io/oauth/callback'
}
