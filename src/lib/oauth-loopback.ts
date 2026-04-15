import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { HttpClient } from '@/lib/http'
import { v4 as uuidv4 } from 'uuid'
import {
  type OAuthUserInfo,
  type OAuthProvider,
  type OAuthTokens,
  buildAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
} from './auth'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'

/** Timeout for the user to complete auth in the browser (5 minutes) */
const oauthTimeoutMs = 5 * 60 * 1000

/** Sentinel used to distinguish timeout rejections from real errors without fragile string matching */
const oauthTimeout = Symbol('oauth-timeout')

/**
 * Starts an OAuth flow using an in-house localhost loopback server and the system browser.
 *
 * Invokes the Rust `start_oauth_server` command to bind a TCP listener on one of the
 * pre-registered ports (17421–17423) or an OS-assigned fallback. Opens the system browser
 * to the OAuth provider's consent screen, waits for the `"oauth-callback"` Tauri event,
 * then validates the response and exchanges the code for tokens.
 *
 * @param provider - The OAuth provider to authenticate with
 * @param timeoutMs - How long to wait for the user to complete auth (default: 5 minutes)
 * @returns Token + user info on success, `null` on timeout/cancellation
 * @throws On state mismatch, provider error, token exchange failure, or server start failure
 */
export const startOAuthFlowLoopback = async (
  httpClient: HttpClient,
  provider: OAuthProvider,
  timeoutMs = oauthTimeoutMs,
): Promise<{ tokens: OAuthTokens; userInfo: OAuthUserInfo } | null> => {
  const port = await invoke<number>('start_oauth_server')
  const redirectUri = `http://localhost:${port}`

  let unlisten: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const state = uuidv4()
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)

    let resolveUrl!: (url: string) => void
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })

    // Register listener BEFORE opening browser to avoid race condition
    unlisten = await listen<{ url: string }>('oauth-callback', (event) => {
      resolveUrl(event.payload.url)
    })

    const authUrl = await buildAuthUrl(httpClient, provider, state, codeChallenge, redirectUri)
    await openUrl(authUrl)

    const callbackUrl = await Promise.race([
      urlPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(oauthTimeout), timeoutMs)
      }),
    ])

    const url = new URL(callbackUrl)
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (error) {
      throw new Error(error)
    }

    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')

    if (!code || !returnedState) {
      throw new Error('Missing code or state in OAuth callback')
    }
    if (returnedState !== state) {
      throw new Error('OAuth state mismatch')
    }

    const tokens = await exchangeCodeForTokens(httpClient, provider, code, codeVerifier, redirectUri)
    const userInfo = await getUserInfo(provider, tokens.access_token)

    return { tokens, userInfo }
  } catch (err) {
    if (err === oauthTimeout) {
      return null
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    unlisten?.()
    // No cancel needed — the Rust server shuts itself down after one request
  }
}
