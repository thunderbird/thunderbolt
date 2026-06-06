/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MisconfiguredOAuthError, type OAuthConfig, type OAuthTokens } from '@/lib/auth'
import type { HttpClient } from '@/lib/http'
import { getOAuthRedirectUri } from '@/lib/oauth-redirect'
import type { AuthProviderBackendConfig } from '@/types'
import type { TinfoilUserInfo } from './types'

/**
 * Tinfoil OAuth 2.1 public client (PKCE, no secret). The user links their
 * Tinfoil subscription and the app receives a short-lived signed access token
 * it forwards — unparsed — to the Tinfoil enclave, which verifies it locally.
 *
 * `inference:api` authorizes the inference API; `offline_access` is required to
 * receive a (rotating) refresh token so the ~15-minute access token can be
 * refreshed silently.
 */
const tinfoilScope = 'inference:api offline_access'
const tinfoilAuthorizeUrl = 'https://dash.tinfoil.sh/oauth/authorize'

let cachedConfig: AuthProviderBackendConfig | null = null

const fetchBackendConfig = async (httpClient: HttpClient): Promise<AuthProviderBackendConfig> => {
  if (cachedConfig) {
    return cachedConfig
  }
  const result = await httpClient.get('auth/tinfoil/config').json<AuthProviderBackendConfig>()
  if (result.configured) {
    cachedConfig = result
  }
  return result
}

/** Test-only: clears the in-memory backend config cache so each test starts fresh. */
export const resetBackendConfigCacheForTests = (): void => {
  cachedConfig = null
}

export const getOAuthConfig = async (httpClient: HttpClient): Promise<OAuthConfig> => {
  const { client_id: clientId, configured } = await fetchBackendConfig(httpClient)
  const redirectUri = getOAuthRedirectUri()

  return {
    clientId,
    configured,
    redirectUri,
    scope: tinfoilScope,
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
    // Public client — the only thing that can be missing is the client_id.
    throw new MisconfiguredOAuthError('tinfoil', 'both')
  }
  const authUrl = new URL(tinfoilAuthorizeUrl)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri ?? config.redirectUri)
  authUrl.searchParams.set('scope', config.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
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
    .post('auth/tinfoil/exchange', {
      json: { code, code_verifier: codeVerifier, redirect_uri: redirectUri ?? config.redirectUri },
    })
    .json<OAuthTokens>()
}

/**
 * Tinfoil's `inference:api` scope exposes no userinfo endpoint, and the access
 * token is an opaque bearer the client must not parse. So unlike Google/Microsoft
 * there is no profile to fetch — we surface a static identity for the connection
 * card. (The connection itself is the proof of an active Tinfoil subscription;
 * Tinfoil's authorization server refuses to issue a token without one.)
 */
export const getUserInfo = async (_accessToken: string): Promise<TinfoilUserInfo> => {
  return {
    id: 'tinfoil',
    email: '',
    verified_email: true,
    name: 'Tinfoil',
  }
}

export const refreshAccessToken = async (httpClient: HttpClient, refreshToken: string): Promise<OAuthTokens> => {
  return await httpClient.post('auth/tinfoil/refresh', { json: { refresh_token: refreshToken } }).json<OAuthTokens>()
}

/**
 * Revoke the Tinfoil token family (RFC 7009) on disconnect. Best-effort — the
 * caller still clears local credentials even if this fails.
 */
export const revokeTokens = async (httpClient: HttpClient, refreshToken: string): Promise<void> => {
  await httpClient.post('auth/tinfoil/revoke', { json: { refresh_token: refreshToken } })
}
