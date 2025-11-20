import { getSettings } from '@/dal'
import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import { memoize } from '@/lib/memoize'
import { getOAuthRedirectUri } from '@/lib/oauth-redirect'
import type { AuthProviderBackendConfig } from '@/types'
import ky from 'ky'
import type { MicrosoftUserInfo } from './types'

const fetchBackendConfig = memoize(async (): Promise<AuthProviderBackendConfig> => {
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky.get(`${cloudUrl}/auth/microsoft/config`).json<AuthProviderBackendConfig>()
})

export const getOAuthConfig = async (): Promise<OAuthConfig> => {
  const { client_id } = await fetchBackendConfig()
  const redirectUri = getOAuthRedirectUri()

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

export const getUserInfo = async (accessToken: string): Promise<MicrosoftUserInfo> => {
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
