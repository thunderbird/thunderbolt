import { listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { v4 as uuidv4 } from 'uuid'
import {
  GoogleUserInfo,
  OAuthProvider,
  OAuthTokens,
  buildAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
  refreshAccessToken,
} from './auth'
import { isTauri } from './platform'

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
 * Start OAuth flow in a Tauri webview window
 */
export const startOAuthFlowWebview = async (
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null> => {
  if (!isTauri()) {
    throw new Error('OAuth webview flow is only available in Tauri desktop app')
  }

  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const authUrl = await buildAuthUrl(provider, state, codeChallenge)

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

// Re-export the refresh token function
export { refreshAccessToken }
