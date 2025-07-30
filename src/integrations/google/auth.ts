import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import { getCloudUrl } from '@/lib/config'
import { memoize } from '@/lib/memoize'
import { isTauri } from '@/lib/platform'
import type { AuthProviderBackendConfig } from '@/types'
import ky from 'ky'
import type { GoogleUserInfo } from './types'

const fetchBackendConfig = memoize(async (): Promise<AuthProviderBackendConfig> => {
  const cloudUrl = await getCloudUrl()
  return await ky.get(`${cloudUrl}/auth/google/config`).json<AuthProviderBackendConfig>()
})

export const getOAuthConfig = async (): Promise<OAuthConfig> => {
  const { client_id } = await fetchBackendConfig()
  return {
    clientId: client_id,
    redirectUri: isTauri()
      ? window.location.origin + '/oauth-callback.html'
      : window.location.origin + '/oauth/callback',
    scope: [
      'email',
      'profile',
      'openid',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'https://www.googleapis.com/auth/gmail.settings.sharing',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ].join(' '),
  }
}

export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string> => {
  const config = await getOAuthConfig()
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', config.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', config.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  return authUrl.toString()
}

export const exchangeCodeForTokens = async (code: string, codeVerifier: string): Promise<OAuthTokens> => {
  const config = await getOAuthConfig()
  const cloudUrl = await getCloudUrl()
  return await ky
    .post(`${cloudUrl}/auth/google/exchange`, {
      json: { code, code_verifier: codeVerifier, redirect_uri: config.redirectUri },
    })
    .json<OAuthTokens>()
}

export const getUserInfo = async (accessToken: string): Promise<GoogleUserInfo> => {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error('Failed to fetch user info')
  return response.json()
}

export const refreshAccessToken = async (refreshToken: string): Promise<OAuthTokens> => {
  const cloudUrl = await getCloudUrl()
  return await ky.post(`${cloudUrl}/auth/google/refresh`, { json: { refresh_token: refreshToken } }).json<OAuthTokens>()
}
