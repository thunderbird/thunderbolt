import { getSettings } from '@/dal'
import type { GoogleUserInfo } from '@/integrations/google/types'
import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import ky from 'ky'
import { buildOAuthUrl, createBackendConfigFetcher, getRedirectUri } from '../oauth-utils'

const MICROSOFT_SCOPES = 'https://graph.microsoft.com/mail.read User.Read offline_access'

const fetchBackendConfig = createBackendConfigFetcher('microsoft')

export const getOAuthConfig = async (): Promise<OAuthConfig> => {
  const { client_id } = await fetchBackendConfig()

  const redirectUri = getRedirectUri({
    mobile: `msal${client_id}://auth`,
  })

  return {
    clientId: client_id,
    redirectUri,
    scope: MICROSOFT_SCOPES,
  }
}

export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string> => {
  const config = await getOAuthConfig()

  return buildOAuthUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: config.scope,
    state,
    codeChallenge,
    additionalParams: {
      response_mode: 'query',
    },
  })
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
  const data = await ky
    .get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<{
      id: string
      mail?: string
      userPrincipalName: string
      displayName: string
      givenName: string
      surname: string
    }>()

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
