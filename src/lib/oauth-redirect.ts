import { isTauri } from '@/lib/platform'

/**
 * Determines the correct OAuth redirect URI based on the platform
 *
 * - Web: Uses the web callback route at the current origin
 * - Mobile (iOS/Android): Uses App Link / Universal Link (https://thunderbolt.io/oauth/callback)
 * - Desktop (Tauri): Uses local webview callback
 *
 * @returns The appropriate redirect URI for the current platform
 */
export const getOAuthRedirectUri = async (): Promise<string> => {
  if (!isTauri()) {
    return window.location.origin + '/oauth/callback'
  }

  const { platform } = await import('@tauri-apps/plugin-os')
  const currentPlatform = await platform()

  if (currentPlatform === 'ios' || currentPlatform === 'android') {
    return 'https://thunderbolt.io/oauth/callback'
  }

  return window.location.origin + '/oauth-callback.html'
}
