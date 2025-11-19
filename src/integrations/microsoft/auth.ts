import { getSettings } from '@/dal'
import type { GoogleUserInfo } from '@/integrations/google/types'
import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import { memoize } from '@/lib/memoize'
import { isTauri } from '@/lib/platform'
import type { AuthProviderBackendConfig } from '@/types'
import ky from 'ky'

const fetchBackendConfig = memoize(async (): Promise<AuthProviderBackendConfig> => {
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky.get(`${cloudUrl}/auth/microsoft/config`).json<AuthProviderBackendConfig>()
})

/**
 * Get redirect URI for OAuth flow
 * For mobile (iOS/Android), use App Link / Universal Link
 * For desktop, use local webview callback
 * For web, use the web callback route
 */
const getRedirectUri = async (): Promise<string> => {
  if (!isTauri()) {
    return window.location.origin + '/oauth/callback'
  }

  // Check if we're on mobile (iOS or Android)
  const { platform } = await import('@tauri-apps/plugin-os')
  const currentPlatform = await platform()

  if (currentPlatform === 'ios' || currentPlatform === 'android') {
    // Use App Link / Universal Link for mobile
    return 'https://thunderbolt.io/oauth/callback'
  }

  // Use local webview callback for desktop
  return window.location.origin + '/oauth-callback.html'
}

export const getOAuthConfig = async (): Promise<OAuthConfig> => {
  const { client_id } = await fetchBackendConfig()
  const redirectUri = await getRedirectUri()

  return {
    clientId: client_id,
    redirectUri,
    scope: 'https://graph.microsoft.com/mail.read User.Read offline_access',
  }
}

export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string> => {
  const config = await getOAuthConfig()
  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', config.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', config.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('response_mode', 'query')
  return authUrl.toString()
}

export const exchangeCodeForTokens = async (code: string, codeVerifier: string): Promise<OAuthTokens> => {
  const config = await getOAuthConfig()
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky
    .post(`${cloudUrl}/auth/microsoft/exchange`, {
      json: { code, code_verifier: codeVerifier, redirect_uri: config.redirectUri },
    })
    .json<OAuthTokens>()
}

export const getUserInfo = async (accessToken: string): Promise<GoogleUserInfo> => {
  const response = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error('Failed to fetch user info')
  const data = await response.json()
  return {
    id: data.id,
    email: data.mail || data.userPrincipalName,
    verified_email: true,
    name: data.displayName,
    given_name: data.givenName,
    family_name: data.surname,
  }
}

export const refreshAccessToken = async (refreshToken: string): Promise<OAuthTokens> => {
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky
    .post(`${cloudUrl}/auth/microsoft/refresh`, { json: { refresh_token: refreshToken } })
    .json<OAuthTokens>()
}
