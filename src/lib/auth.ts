import { v4 as uuidv4 } from 'uuid'

import * as google from '@/integrations/google/auth'
import type { GoogleUserInfo } from '@/integrations/google/types'
import * as microsoft from '@/integrations/microsoft/auth'
import { isTauri } from '@/lib/platform'

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

export const buildAuthUrl = async (provider: OAuthProvider, state: string, codeChallenge: string): Promise<string> => {
  return providers[provider].buildAuthUrl(state, codeChallenge)
}

export const exchangeCodeForTokens = async (
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokens> => {
  return providers[provider].exchangeCodeForTokens(code, codeVerifier)
}

export const getUserInfo = async (provider: OAuthProvider, accessToken: string): Promise<GoogleUserInfo> => {
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
): Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo }> => {
  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const authUrl = await buildAuthUrl(provider, state, codeChallenge)

  // Persist values for callback validation
  sessionStorage.setItem('oauth_state', state)
  sessionStorage.setItem('oauth_provider', provider)
  sessionStorage.setItem('oauth_verifier', codeVerifier)

  let popup: Window | null = null

  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(authUrl)
  } else {
    popup = window.open(authUrl, '_blank', 'noopener,noreferrer,width=600,height=700')
    if (!popup) throw new Error('Failed to open authentication window')
    popup.focus()
  }

  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        window.removeEventListener('message', handler)
        if (popup && !popup.closed) popup.close()

        if (event.data.error) reject(new Error(event.data.error))
        else resolve({ code: event.data.code, state: event.data.state })
      }
    }

    window.addEventListener('message', handler)

    setTimeout(
      () => {
        window.removeEventListener('message', handler)
        reject(new Error('OAuth timeout - please try again'))
      },
      10 * 60 * 1000,
    )
  })

  const { code, state: returnedState } = await callback
  if (returnedState !== state) throw new Error('OAuth state mismatch')

  const storedVerifier = sessionStorage.getItem('oauth_verifier')
  if (!storedVerifier) throw new Error('OAuth code verifier not found')

  const tokens = await exchangeCodeForTokens(provider, code, storedVerifier)
  const userInfo = await getUserInfo(provider, tokens.access_token)

  sessionStorage.removeItem('oauth_state')
  sessionStorage.removeItem('oauth_provider')
  sessionStorage.removeItem('oauth_verifier')

  return { tokens, userInfo }
}

export const redirectOAuthFlow = async (provider: OAuthProvider): Promise<never> => {
  if (isTauri()) throw new Error('redirectOAuthFlow should only be used in the web environment')

  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const authUrl = await buildAuthUrl(provider, state, codeChallenge)

  sessionStorage.setItem('oauth_state', state)
  sessionStorage.setItem('oauth_provider', provider)
  sessionStorage.setItem('oauth_verifier', codeVerifier)

  window.location.assign(authUrl)
  throw new Error('Redirecting for OAuth')
}

// ---------------------------------------------------------------------------
// Re-export shared types so callers can import from one module
// ---------------------------------------------------------------------------
export type { GoogleUserInfo } from '@/integrations/google/types'
