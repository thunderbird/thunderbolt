import { isMobile, isTauri } from '@/lib/platform'

/**
 * Determines the correct OAuth redirect URI based on the platform
 *
 * - Web: Uses the web callback route at the current origin
 * - Mobile (iOS/Android): Uses App Link / Universal Link (https://thunderbolt.io/oauth/callback)
 * - Desktop (Tauri): Uses local webview callback
 *
 * @returns The appropriate redirect URI for the current platform
 */
export const getOAuthRedirectUri = (): string => {
  if (!isTauri()) {
    return window.location.origin + '/oauth/callback'
  }

  if (isMobile()) {
    // Mobile: Use App Link / Universal Link (verified HTTPS domain)
    return 'https://thunderbolt.io/oauth/callback'
  }

  return window.location.origin + '/oauth-callback.html'
}
