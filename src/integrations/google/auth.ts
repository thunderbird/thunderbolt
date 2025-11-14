import { getSettings } from '@/dal'
import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import ky from 'ky'
import { buildOAuthUrl, createBackendConfigFetcher, getRedirectUri } from '../oauth-utils'
import type { GoogleUserInfo } from './types'

const GOOGLE_SCOPES = [
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
].join(' ')

const fetchBackendConfig = createBackendConfigFetcher('google')

export const getOAuthConfig = async (): Promise<OAuthConfig> => {
  const { client_id } = await fetchBackendConfig()

  const redirectUri = getRedirectUri({
    mobile: `com.googleusercontent.apps.${client_id.split('.')[0]}:/oauth2redirect`,
  })

  return {
    clientId: client_id,
    redirectUri,
    scope: GOOGLE_SCOPES,
  }
}

export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string> => {
  const config = await getOAuthConfig()

  return buildOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth', {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: config.scope,
    state,
    codeChallenge,
    additionalParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  })
}

export const exchangeCodeForTokens = async (code: string, codeVerifier: string): Promise<OAuthTokens> => {
  const config = await getOAuthConfig()
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky
    .post(`${cloudUrl}/auth/google/exchange`, {
      json: { code, code_verifier: codeVerifier, redirect_uri: config.redirectUri },
    })
    .json<OAuthTokens>()
}

export const getUserInfo = async (accessToken: string): Promise<GoogleUserInfo> => {
  return await ky
    .get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<GoogleUserInfo>()
}

export const refreshAccessToken = async (refreshToken: string): Promise<OAuthTokens> => {
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky.post(`${cloudUrl}/auth/google/refresh`, { json: { refresh_token: refreshToken } }).json<OAuthTokens>()
}
