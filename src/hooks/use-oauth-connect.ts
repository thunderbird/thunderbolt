import { deleteSetting, getSettings, updateSettings } from '@/dal'
import { buildAuthUrl, exchangeCodeForTokens, getUserInfo, redirectOAuthFlow, type OAuthProvider } from '@/lib/auth'
import { startOAuthFlowWebview } from '@/lib/oauth-webview'
import { generateCodeChallenge, generateCodeVerifier } from '@/lib/pkce'
import { isMobile, isTauri } from '@/lib/platform'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

type OAuthDependencies = {
  startOAuthFlowWebview?: typeof startOAuthFlowWebview
  redirectOAuthFlow?: typeof redirectOAuthFlow
  exchangeCodeForTokens?: typeof exchangeCodeForTokens
  getUserInfo?: typeof getUserInfo
}

type UseOAuthConnectOptions = {
  onSuccess?: () => void
  onError?: (error: Error) => void
  setPreferredName?: boolean
  returnContext?: string
  dependencies?: OAuthDependencies
}

type UseOAuthConnectResult = {
  connect: (provider: OAuthProvider) => Promise<void>
  processCallback: (callbackData: OAuthCallbackData) => Promise<boolean>
  error: string | null
  clearError: () => void
}

type OAuthCallbackData = {
  code?: string
  state?: string
  error?: string
}

/**
 * Saves OAuth credentials and enables the integration
 */
const saveOAuthCredentials = async (
  provider: OAuthProvider,
  tokens: { access_token: string; refresh_token?: string; expires_in: number },
  userInfo: { email: string; name: string; picture?: string },
  options: { setPreferredName: boolean },
) => {
  const credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || '',
    expires_at: Date.now() + tokens.expires_in * 1000,
    profile: {
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
    },
  }

  await updateSettings({
    [`integrations_${provider}_credentials`]: JSON.stringify(credentials),
    [`integrations_${provider}_is_enabled`]: 'true',
  })

  if (options.setPreferredName && userInfo.name) {
    await updateSettings({ preferred_name: userInfo.name })
  }
}

/**
 * Handles OAuth connection flow for any provider.
 * For Tauri: Opens separate webview window and processes result immediately.
 * For web: Redirects to OAuth provider and processes callback on return.
 *
 * @param options.dependencies - Injectable dependencies for testing (optional)
 */
export const useOAuthConnect = (options: UseOAuthConnectOptions = {}): UseOAuthConnectResult => {
  const { onSuccess, onError, setPreferredName = false, returnContext = 'integrations', dependencies } = options
  const [error, setError] = useState<string | null>(null)

  // Use injected dependencies or fall back to real implementations
  const {
    startOAuthFlowWebview: startFlow = startOAuthFlowWebview,
    redirectOAuthFlow: redirect = redirectOAuthFlow,
    exchangeCodeForTokens: exchangeTokens = exchangeCodeForTokens,
    getUserInfo: getUser = getUserInfo,
  } = dependencies || {}

  const connect = async (provider: OAuthProvider) => {
    setError(null)

    try {
      if (isTauri()) {
        // Check if we're on mobile (iOS or Android)
        if (isMobile()) {
          // For mobile: Open OAuth in system browser with App Link / Universal Link redirect
          // The deep link listener will handle the callback
          const state = uuidv4()
          const codeVerifier = generateCodeVerifier()
          const codeChallenge = await generateCodeChallenge(codeVerifier)

          // Store OAuth state for callback validation
          await updateSettings({
            oauth_state: state,
            oauth_provider: provider,
            oauth_verifier: codeVerifier,
            oauth_return_context: returnContext,
          })

          const authUrl = await buildAuthUrl(provider, state, codeChallenge)

          // Open in system browser (not webview)
          await openUrl(authUrl)

          // The callback will be handled by the deep link listener
        } else {
          // For desktop: Use webview flow
          const result = await startFlow(provider)

          if (!result) return

          const { tokens, userInfo } = result

          await saveOAuthCredentials(provider, tokens, userInfo, { setPreferredName })

          onSuccess?.()
        }
      } else {
        // For web: Use redirect flow
        await updateSettings({ oauth_return_context: returnContext })
        await redirect(provider)
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to complete authentication'
      setError(message)
      onError?.(e instanceof Error ? e : new Error(message))
    }
  }

  /**
   * Processes OAuth callback data from redirect.
   * Returns true if successful, false otherwise.
   */
  const processCallback = async (callbackData: OAuthCallbackData): Promise<boolean> => {
    setError(null)

    const { code, state: returnedState, error: oauthError } = callbackData

    if (oauthError) {
      const message = oauthError
      setError(message)
      onError?.(new Error(message))
      return false
    }

    if (!code || !returnedState) {
      return false
    }

    // Get OAuth state from sqlite settings
    const settings = await getSettings({
      oauth_state: String,
      oauth_provider: String,
      oauth_verifier: String,
    })

    const storedState = settings.oauthState
    const provider = settings.oauthProvider as OAuthProvider | null
    const codeVerifier = settings.oauthVerifier

    if (!provider || !codeVerifier || storedState !== returnedState) {
      const message = 'OAuth validation failed'
      setError(message)
      onError?.(new Error(message))
      return false
    }

    try {
      const tokens = await exchangeTokens(provider, code, codeVerifier)
      const userInfo = await getUser(provider, tokens.access_token)

      await saveOAuthCredentials(provider, tokens, userInfo, { setPreferredName })

      // Cleanup OAuth state from sqlite
      await Promise.all([
        deleteSetting('oauth_state'),
        deleteSetting('oauth_provider'),
        deleteSetting('oauth_verifier'),
        deleteSetting('oauth_return_context'),
      ])

      onSuccess?.()
      return true
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to complete authentication'
      setError(message)
      onError?.(e instanceof Error ? e : new Error(message))
      return false
    }
  }

  const clearError = () => setError(null)

  return { connect, processCallback, error, clearError }
}

export type { OAuthCallbackData, OAuthDependencies, UseOAuthConnectResult }
