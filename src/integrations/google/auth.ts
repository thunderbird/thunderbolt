import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import { getHttpClient } from '@/lib/http-client'
import { memoize } from '@/lib/memoize'
import { getOAuthRedirectUri } from '@/lib/oauth-redirect'
import type { AuthProviderBackendConfig } from '@/types'
import type { GoogleUserInfo } from './types'

const fetchBackendConfig = memoize(async (): Promise<AuthProviderBackendConfig> => {
  return await getHttpClient().get('auth/google/config').json<AuthProviderBackendConfig>()
})

export const getOAuthConfig = async (): Promise<OAuthConfig> => {
  const { client_id: clientId } = await fetchBackendConfig()
  const redirectUri = getOAuthRedirectUri()

  return {
    clientId,
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

export const buildAuthUrl = async (state: string, codeChallenge: string, redirectUri?: string): Promise<string> => {
  const config = await getOAuthConfig()
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
  code: string,
  codeVerifier: string,
  redirectUri?: string,
): Promise<OAuthTokens> => {
  const config = await getOAuthConfig()
  return await getHttpClient()
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

export const refreshAccessToken = async (refreshToken: string): Promise<OAuthTokens> => {
  return await getHttpClient()
    .post('auth/google/refresh', { json: { refresh_token: refreshToken } })
    .json<OAuthTokens>()
}
