import * as google from '@/integrations/google/auth'
import type { GoogleUserInfo } from '@/integrations/google/types'
import * as microsoft from '@/integrations/microsoft/auth'
import type { HttpClient } from '@/lib/http'
import { setOAuthState } from '@/lib/oauth-state'
import { generateCodeChallenge, generateCodeVerifier } from '@/lib/pkce'
import { isTauri } from '@/lib/platform'
import { v4 as uuidv4 } from 'uuid'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthProvider = 'google' | 'microsoft'

export type OAuthConfig = {
  clientId: string
  configured: boolean
  redirectUri: string
  scope: string
}

export type OAuthTokens = {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

/**
 * Provider-agnostic user info returned by all OAuth providers.
 * Use this type at the provider-agnostic boundary instead of the
 * provider-specific GoogleUserInfo.
 */
export type OAuthUserInfo = GoogleUserInfo

const providers = {
  google,
  microsoft,
} as const satisfies Record<OAuthProvider, typeof google>

// ---------------------------------------------------------------------------
// Provider-agnostic wrappers
// ---------------------------------------------------------------------------

export const getOAuthConfig = async (httpClient: HttpClient, provider: OAuthProvider): Promise<OAuthConfig> => {
  return providers[provider].getOAuthConfig(httpClient)
}

/**
 * Builds the OAuth authorization URL for the given provider.
 *
 * @param redirectUri - Optional redirect URI override for flows that determine
 *   the URI at runtime (e.g. loopback server). When provided, the **same value**
 *   must be passed to {@link exchangeCodeForTokens} for the same flow — OAuth
 *   providers reject the token exchange if the two redirect URIs differ.
 */
export const buildAuthUrl = async (
  httpClient: HttpClient,
  provider: OAuthProvider,
  state: string,
  codeChallenge: string,
  redirectUri?: string,
): Promise<string> => {
  return providers[provider].buildAuthUrl(httpClient, state, codeChallenge, redirectUri)
}

/**
 * Exchanges an authorization code for OAuth tokens.
 *
 * @param redirectUri - Must match the value passed to {@link buildAuthUrl}
 *   for the same flow. Omit when buildAuthUrl was also called without one.
 */
export const exchangeCodeForTokens = async (
  httpClient: HttpClient,
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
  redirectUri?: string,
): Promise<OAuthTokens> => {
  return providers[provider].exchangeCodeForTokens(httpClient, code, codeVerifier, redirectUri)
}

export const getUserInfo = async (provider: OAuthProvider, accessToken: string): Promise<OAuthUserInfo> => {
  return providers[provider].getUserInfo(accessToken)
}

export const refreshAccessToken = async (
  httpClient: HttpClient,
  provider: OAuthProvider,
  refreshToken: string,
): Promise<OAuthTokens> => {
  return providers[provider].refreshAccessToken(httpClient, refreshToken)
}

// ---------------------------------------------------------------------------
// Redirect flow (web only)
// ---------------------------------------------------------------------------

export const redirectOAuthFlow = async (httpClient: HttpClient, provider: OAuthProvider): Promise<never> => {
  if (isTauri()) {
    throw new Error('redirectOAuthFlow should only be used in the web environment')
  }

  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const authUrl = await buildAuthUrl(httpClient, provider, state, codeChallenge)

  await setOAuthState({
    state,
    provider,
    verifier: codeVerifier,
  })

  window.location.assign(authUrl)
  throw new Error('Redirecting for OAuth')
}

// ---------------------------------------------------------------------------
// Re-export shared types so callers can import from one module
// ---------------------------------------------------------------------------
export type { GoogleUserInfo } from '@/integrations/google/types'
