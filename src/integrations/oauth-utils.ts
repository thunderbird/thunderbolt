import { getSettings } from '@/dal'
import { isTauri, isDesktop, isMobile, getPlatform } from '@/lib/platform'
import type { AuthProviderBackendConfig } from '@/types'
import ky from 'ky'
import { memoize } from '@/lib/memoize'

/**
 * Creates a memoized backend config fetcher for an OAuth provider
 */
export const createBackendConfigFetcher = (provider: 'google' | 'microsoft') => {
  return memoize(async (): Promise<AuthProviderBackendConfig> => {
    const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })

    // Pass specific platform (ios, android) for mobile, nothing for web/desktop
    const currentPlatform = getPlatform()
    const platformParam =
      currentPlatform === 'ios' || currentPlatform === 'android' ? `?platform=${currentPlatform}` : ''

    const url = `${cloudUrl}/auth/${provider}/config${platformParam}`
    return await ky.get(url).json<AuthProviderBackendConfig>()
  })
}

type RedirectUriConfig = {
  mobile: string
  desktop?: string
  web?: string
}

/**
 * Determines redirect URI based on platform
 */
export const getRedirectUri = (config: RedirectUriConfig): string => {
  if (isTauri()) {
    if (isMobile()) return config.mobile
    if (isDesktop()) return config.desktop || `${window.location.origin}/oauth-callback.html`
    return config.web || `${window.location.origin}/oauth/callback`
  }
  return config.web || `${window.location.origin}/oauth/callback`
}

/**
 * Builds OAuth authorization URL with common parameters
 */
export const buildOAuthUrl = (
  baseUrl: string,
  params: {
    clientId: string
    redirectUri: string
    scope: string
    state: string
    codeChallenge: string
    additionalParams?: Record<string, string>
  },
): string => {
  const authUrl = new URL(baseUrl)
  authUrl.searchParams.set('client_id', params.clientId)
  authUrl.searchParams.set('redirect_uri', params.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', params.scope)
  authUrl.searchParams.set('state', params.state)
  authUrl.searchParams.set('code_challenge', params.codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  if (params.additionalParams) {
    Object.entries(params.additionalParams).forEach(([key, value]) => {
      authUrl.searchParams.set(key, value)
    })
  }

  return authUrl.toString()
}
