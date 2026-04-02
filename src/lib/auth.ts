import { v4 as uuidv4 } from 'uuid'

import * as google from '@/integrations/google/auth'
import type { GoogleUserInfo } from '@/integrations/google/types'
import * as microsoft from '@/integrations/microsoft/auth'
import { isTauri } from '@/lib/platform'
import { waitForOAuthCallback } from '@/lib/oauth-callback'
import { setOAuthState, getOAuthState, clearOAuthState } from '@/lib/oauth-state'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthProvider = 'google' | 'microsoft'

export type OAuthConfig = {
  clientId: string
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

export const getOAuthConfig = async (provider: OAuthProvider): Promise<OAuthConfig> => {
  return providers[provider].getOAuthConfig()
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
  provider: OAuthProvider,
  state: string,
  codeChallenge: string,
  redirectUri?: string,
): Promise<string> => {
  return providers[provider].buildAuthUrl(state, codeChallenge, redirectUri)
}

/**
 * Exchanges an authorization code for OAuth tokens.
 *
 * @param redirectUri - Must match the value passed to {@link buildAuthUrl}
 *   for the same flow. Omit when buildAuthUrl was also called without one.
 */
export const exchangeCodeForTokens = async (
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
  redirectUri?: string,
): Promise<OAuthTokens> => {
  return providers[provider].exchangeCodeForTokens(code, codeVerifier, redirectUri)
}

export const getUserInfo = async (provider: OAuthProvider, accessToken: string): Promise<OAuthUserInfo> => {
  return providers[provider].getUserInfo(accessToken)
}

export const refreshAccessToken = async (provider: OAuthProvider, refreshToken: string): Promise<OAuthTokens> => {
  return providers[provider].refreshAccessToken(refreshToken)
}

// ---------------------------------------------------------------------------
// Generic flows (moved from old auth/index.ts)
// ---------------------------------------------------------------------------

const generateCodeVerifier = (): string => {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export const startOAuthFlow = async (
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; userInfo: OAuthUserInfo }> => {
  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const authUrl = await buildAuthUrl(provider, state, codeChallenge)

  // Persist values for callback validation
  await setOAuthState({
    state,
    provider,
    verifier: codeVerifier,
  })

  let popup: Window | null = null

  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(authUrl)
  } else {
    popup = window.open(authUrl, '_blank', 'noopener,noreferrer,width=600,height=700')
    if (!popup) {
      throw new Error('Failed to open authentication window')
    }
    popup.focus()
  }

  const { code, state: returnedState } = await waitForOAuthCallback(popup)
  if (returnedState !== state) {
    throw new Error('OAuth state mismatch')
  }

  const oauthState = await getOAuthState()
  if (!oauthState.verifier) {
    throw new Error('OAuth code verifier not found')
  }

  const tokens = await exchangeCodeForTokens(provider, code, oauthState.verifier)
  const userInfo = await getUserInfo(provider, tokens.access_token)

  await clearOAuthState()

  return { tokens, userInfo }
}

export const redirectOAuthFlow = async (provider: OAuthProvider): Promise<never> => {
  if (isTauri()) {
    throw new Error('redirectOAuthFlow should only be used in the web environment')
  }

  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const authUrl = await buildAuthUrl(provider, state, codeChallenge)

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
