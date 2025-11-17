import { listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { v4 as uuidv4 } from 'uuid'
import {
  type GoogleUserInfo,
  type OAuthProvider,
  type OAuthTokens,
  buildAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
  refreshAccessToken,
} from './auth'
import { isTauri, isMobile } from './platform'

/**
 * Generate a code verifier for PKCE
 */
const generateCodeVerifier = (): string => {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Generate code challenge from verifier
 */
const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Start OAuth flow in a Tauri webview window (desktop) or external browser (mobile)
 */
export const startOAuthFlowWebview = async (
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null> => {
  if (!isTauri()) {
    throw new Error('OAuth webview flow is only available in Tauri app')
  }

  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const authUrl = await buildAuthUrl(provider, state, codeChallenge)

  // Mobile: Open in system browser and wait for deep link callback
  if (isMobile()) {
    sessionStorage.setItem('oauth_state', state)
    sessionStorage.setItem('oauth_provider', provider)
    sessionStorage.setItem('oauth_verifier', codeVerifier)

    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(authUrl)
    } catch (error) {
      throw new Error(`Failed to open browser: ${error}`)
    }

    const result = await waitForDeepLinkCallback()

    if (!result) {
      return null
    }

    const { code, state: returnedState } = result

    if (returnedState !== state) {
      throw new Error('OAuth state mismatch')
    }

    const tokens = await exchangeCodeForTokens(provider, code, codeVerifier)
    const userInfo = await getUserInfo(provider, tokens.access_token)

    return { tokens, userInfo }
  }

  // Desktop: Use separate webview window
  const oauthWindow = new WebviewWindow(`oauth-${Date.now()}`, {
    url: authUrl,
    title: `Connect ${provider === 'google' ? 'Google' : 'Microsoft'} Account`,
    width: 600,
    height: 800,
    center: true,
    resizable: false,
  })

  const result = await waitForCallback(oauthWindow)

  if (!result) {
    return null
  }

  const { code, state: returnedState } = result

  if (returnedState !== state) {
    throw new Error('OAuth state mismatch')
  }

  const tokens = await exchangeCodeForTokens(provider, code, codeVerifier)
  const userInfo = await getUserInfo(provider, tokens.access_token)

  return { tokens, userInfo }
}

async function waitForCallback(window: WebviewWindow): Promise<{ code: string; state: string } | null> {
  return new Promise(async (resolve, reject) => {
    const cleanup = async () => {
      unlistenCallback()
      unlistenNavigate()
      await window.destroy()
    }

    const handleCallback = (code: string | null, state: string | null, error: string | null) => {
      if (error) {
        cleanup()
        reject(new Error(error))
      } else if (code && state) {
        cleanup()
        resolve({ code, state })
      }
    }

    const unlistenCallback = await listen('oauth-callback', (event: any) => {
      const { code, state, error } = event.payload || {}
      handleCallback(code, state, error)
    })

    const unlistenNavigate = await window.listen('tauri://navigate', (event: any) => {
      const url = new URL(event.payload)
      if (!url.pathname.includes('oauth-callback.html')) return

      const params = url.searchParams
      handleCallback(params.get('code'), params.get('state'), params.get('error') || params.get('error_description'))
    })

    window.once('tauri://close-requested', () => {
      cleanup()
      resolve(null)
    })
  })
}

/**
 * Wait for deep link callback on mobile (e.g., thunderbolt://oauth/callback?code=...&state=...)
 */
async function waitForDeepLinkCallback(): Promise<{ code: string; state: string } | null> {
  return new Promise(async (resolve, reject) => {
    let unlisten: (() => void) | null = null

    const timeout = setTimeout(
      () => {
        if (unlisten) unlisten()
        reject(new Error('OAuth timeout - please try again'))
      },
      10 * 60 * 1000,
    )

    try {
      const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')

      unlisten = await onOpenUrl((urls) => {
        try {
          const urlString = urls[0]
          if (!urlString) {
            clearTimeout(timeout)
            if (unlisten) unlisten()
            resolve(null)
            return
          }

          const url = new URL(urlString)

          // Check if this is an OAuth callback URL (supports multiple formats)
          const isThunderboltScheme =
            url.protocol === 'thunderbolt:' && url.host === 'oauth' && url.pathname === '/callback'
          const isMobileScheme =
            url.protocol.startsWith('com.googleusercontent.apps.') || url.protocol.startsWith('msal')
          if (!isThunderboltScheme && !isMobileScheme) {
            return
          }

          // Valid OAuth callback - cleanup and process
          clearTimeout(timeout)
          if (unlisten) unlisten()

          const params = url.searchParams
          const code = params.get('code')
          const state = params.get('state')
          const error = params.get('error') || params.get('error_description')

          if (error) {
            reject(new Error(error))
          } else if (code && state) {
            resolve({ code, state })
          } else {
            resolve(null)
          }
        } catch (err) {
          clearTimeout(timeout)
          if (unlisten) unlisten()
          reject(err instanceof Error ? err : new Error('Failed to parse deep link'))
        }
      })
    } catch (err) {
      clearTimeout(timeout)
      reject(err instanceof Error ? err : new Error('Failed to set up deep link listener'))
    }
  })
}

// Re-export the refresh token function
export { refreshAccessToken }
