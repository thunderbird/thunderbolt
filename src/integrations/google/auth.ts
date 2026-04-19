import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import type { HttpClient } from '@/lib/http'
import { getOAuthRedirectUri } from '@/lib/oauth-redirect'
import type { AuthProviderBackendConfig } from '@/types'
import type { GoogleUserInfo } from './types'

let cachedBackendConfig: Promise<AuthProviderBackendConfig> | null = null

const fetchBackendConfig = (httpClient: HttpClient): Promise<AuthProviderBackendConfig> => {
  if (!cachedBackendConfig) {
    cachedBackendConfig = httpClient.get('auth/google/config').json<AuthProviderBackendConfig>()
    cachedBackendConfig.catch(() => {
      cachedBackendConfig = null
    })
  }
  return cachedBackendConfig
}

export const getOAuthConfig = async (httpClient: HttpClient): Promise<OAuthConfig> => {
  const { client_id: clientId, configured } = await fetchBackendConfig(httpClient)
  const redirectUri = getOAuthRedirectUri()

  return {
    clientId,
    configured,
    redirectUri,
    scope: [
      'email',
      'profile',
      'openid',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ].join(' '),
  }
}

export const buildAuthUrl = async (
  httpClient: HttpClient,
  state: string,
  codeChallenge: string,
  redirectUri?: string,
): Promise<string> => {
  const config = await getOAuthConfig(httpClient)
  if (!config.configured) {
    throw new Error(
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend before enabling Google integration.',
    )
  }
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri ?? config.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', config.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  return authUrl.toString()
}

export const exchangeCodeForTokens = async (
  httpClient: HttpClient,
  code: string,
  codeVerifier: string,
  redirectUri?: string,
): Promise<OAuthTokens> => {
  const config = await getOAuthConfig(httpClient)
  return await httpClient
    .post('auth/google/exchange', {
      json: { code, code_verifier: codeVerifier, redirect_uri: redirectUri ?? config.redirectUri },
    })
    .json<OAuthTokens>()
}

export const getUserInfo = async (accessToken: string): Promise<GoogleUserInfo> => {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error('Failed to fetch user info')
  }
  return response.json()
}

export const refreshAccessToken = async (httpClient: HttpClient, refreshToken: string): Promise<OAuthTokens> => {
  return await httpClient.post('auth/google/refresh', { json: { refresh_token: refreshToken } }).json<OAuthTokens>()
}
