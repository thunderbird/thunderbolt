/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthConfig, OAuthTokens } from '@/lib/auth'
import type { HttpClient } from '@/lib/http'
import { getOAuthRedirectUri } from '@/lib/oauth-redirect'
import type { AuthProviderBackendConfig } from '@/types'
import type { MicrosoftUserInfo } from './types'

let cachedBackendConfig: Promise<AuthProviderBackendConfig> | null = null

const fetchBackendConfig = (httpClient: HttpClient): Promise<AuthProviderBackendConfig> => {
  if (!cachedBackendConfig) {
    cachedBackendConfig = httpClient.get('auth/microsoft/config').json<AuthProviderBackendConfig>()
    cachedBackendConfig.catch(() => {
      cachedBackendConfig = null
    })
  }
  return cachedBackendConfig
}

export const getOAuthConfig = async (httpClient: HttpClient): Promise<OAuthConfig> => {
  const { client_id: clientId } = await fetchBackendConfig(httpClient)

  if (!clientId) {
    // Reset cache so configuration can be picked up after backend env changes.
    cachedBackendConfig = null
    throw new Error(
      'Microsoft sync is not configured on this server. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
    )
  }

  const redirectUri = getOAuthRedirectUri()

  return {
    clientId,
    redirectUri,
    scope: 'https://graph.microsoft.com/mail.read User.Read offline_access',
  }
}

export const buildAuthUrl = async (
  httpClient: HttpClient,
  state: string,
  codeChallenge: string,
  redirectUri?: string,
): Promise<string> => {
  const config = await getOAuthConfig(httpClient)
  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri ?? config.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', config.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('response_mode', 'query')
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
    .post('auth/microsoft/exchange', {
      json: { code, code_verifier: codeVerifier, redirect_uri: redirectUri ?? config.redirectUri },
    })
    .json<OAuthTokens>()
}

export const getUserInfo = async (accessToken: string): Promise<MicrosoftUserInfo> => {
  const response = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error('Failed to fetch user info')
  }
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

export const refreshAccessToken = async (httpClient: HttpClient, refreshToken: string): Promise<OAuthTokens> => {
  return await httpClient.post('auth/microsoft/refresh', { json: { refresh_token: refreshToken } }).json<OAuthTokens>()
}
