/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useDatabase } from '@/contexts'
import { saveIntegrationCredentials, updateSettings } from '@/dal'
import { buildAuthUrl, exchangeCodeForTokens, getUserInfo, redirectOAuthFlow, type OAuthProvider } from '@/lib/auth'
import { startOAuthFlowLoopback } from '@/lib/oauth-loopback'
import {
  createIntegrationOAuthClient,
  getIntegrationRelayUrl,
  getIntegrationOAuthErrorMessage,
} from '@/lib/integration-oauth-client'
import { clearOAuthState, getOAuthState, setOAuthState } from '@/lib/oauth-state'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import { generateCodeChallenge, generateCodeVerifier } from '@/lib/pkce'
import type { ReturnContext } from '@/lib/oauth-state'
import { isMobile, isTauri } from '@/lib/platform'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useQueryClient } from '@tanstack/react-query'
import { useReducer } from 'react'
import { useAsyncAttempt } from './use-async-attempt'
import { v4 as uuidv4 } from 'uuid'

type OAuthDependencies = {
  startOAuthFlowLoopback?: typeof startOAuthFlowLoopback
  redirectOAuthFlow?: typeof redirectOAuthFlow
  exchangeCodeForTokens?: typeof exchangeCodeForTokens
  getUserInfo?: typeof getUserInfo
}

type UseOAuthConnectOptions = {
  onSuccess?: () => void
  onError?: (error: Error) => void
  setPreferredName?: boolean
  returnContext?: ReturnContext
  dependencies?: OAuthDependencies
}

type UseOAuthConnectResult = {
  connect: (provider: OAuthProvider) => Promise<void>
  processCallback: (callbackData: OAuthCallbackData) => Promise<boolean>
  isConnecting: boolean
  error: string | null
  clearError: () => void
}

type OAuthCallbackData = {
  code?: string
  state?: string
  error?: string
}

type OAuthUiState = { phase: 'idle' | 'connecting' } | { phase: 'error'; message: string }
type OAuthUiAction =
  | { type: 'START' }
  | { type: 'SETTLE' }
  | { type: 'ERROR'; message: string }
  | { type: 'CLEAR_ERROR' }

const oauthUiReducer = (state: OAuthUiState, action: OAuthUiAction): OAuthUiState => {
  switch (action.type) {
    case 'START':
      return { phase: 'connecting' }
    case 'SETTLE':
      return { phase: 'idle' }
    case 'ERROR':
      return { phase: 'error', message: action.message }
    case 'CLEAR_ERROR':
      return state.phase === 'error' ? { phase: 'idle' } : state
  }
}

/**
 * Handles OAuth connection flow for any provider.
 * Desktop uses a loopback callback; mobile hands off to the system browser and a deep link.
 * For web: Redirects to OAuth provider and processes callback on return.
 */
export const useOAuthConnect = (options: UseOAuthConnectOptions = {}): UseOAuthConnectResult => {
  const { t, i18n } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { onSuccess, onError, setPreferredName = false, returnContext = 'integrations', dependencies } = options
  const [state, dispatch] = useReducer(oauthUiReducer, { phase: 'idle' })
  const operation = useAsyncAttempt()

  // Use injected dependencies or fall back to real implementations
  const {
    startOAuthFlowLoopback: startLoopback = startOAuthFlowLoopback,
    redirectOAuthFlow: redirect = redirectOAuthFlow,
    exchangeCodeForTokens: exchangeTokens = exchangeCodeForTokens,
    getUserInfo: getUser = getUserInfo,
  } = dependencies || {}

  const describeError = (error: unknown) => {
    const message = getIntegrationOAuthErrorMessage(error)
    return message ? i18n._(message) : error instanceof Error ? error.message : t`Failed to complete authentication`
  }

  /**
   * Saves OAuth credentials and enables the integration
   */
  const saveCredentials = async (
    provider: OAuthProvider,
    tokens: { access_token: string; refresh_token?: string; expires_in: number },
    userInfo: { email: string; name: string; picture?: string },
    oauthRelayUrl: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted()
    const credentials = {
      oauthRelayUrl,
      sessionRevision: crypto.randomUUID(),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_at: Date.now() + tokens.expires_in * 1000,
      profile: {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
      },
    }

    await db.transaction(async (tx) => {
      signal.throwIfAborted()
      await saveIntegrationCredentials(tx, provider, credentials, true)
      signal.throwIfAborted()
    })
    await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
    signal.throwIfAborted()

    if (setPreferredName && userInfo.name) {
      await updateSettings(db, { preferred_name: userInfo.name }, { signal })
    }
  }

  const connect = async (provider: OAuthProvider) => {
    const identitySignal = getIdentitySignal()
    const attempt = operation.begin()
    if (!attempt) {
      return
    }

    dispatch({ type: 'START' })
    const oauthRelayUrl = getIntegrationRelayUrl()
    const httpClient = createIntegrationOAuthClient(oauthRelayUrl)
    clearOAuthState()

    try {
      if (isTauri()) {
        // Check if we're on mobile (iOS or Android)
        if (isMobile()) {
          // For mobile: Open OAuth in system browser with App Link / Universal Link redirect
          // The deep link listener will handle the callback
          const state = uuidv4()
          const codeVerifier = generateCodeVerifier()
          const codeChallenge = await generateCodeChallenge(codeVerifier)
          if (!attempt.isCurrent() || identitySignal.aborted) {
            return
          }

          // Store OAuth state for callback validation
          setOAuthState({
            state,
            provider,
            verifier: codeVerifier,
            returnContext,
            oauthRelayUrl,
          })

          const authUrl = await buildAuthUrl(httpClient, provider, state, codeChallenge)
          if (!attempt.isCurrent() || identitySignal.aborted) {
            return
          }

          // Open in system browser (not webview)
          await openUrl(authUrl)

          // The handoff is complete. A cancelled browser login leaves this screen
          // usable; a returned deep link owns its own callback progress.
          if (attempt.isCurrent()) {
            dispatch({ type: 'SETTLE' })
          }
        } else {
          // For desktop: Use system browser + loopback server flow.
          const result = await startLoopback(httpClient, provider)
          if (!attempt.isCurrent() || identitySignal.aborted) {
            return
          }

          if (!result) {
            dispatch({ type: 'SETTLE' })
            return
          }

          const { tokens, userInfo } = result

          await saveCredentials(provider, tokens, userInfo, oauthRelayUrl, identitySignal)
          if (!attempt.isCurrent() || identitySignal.aborted) {
            return
          }

          dispatch({ type: 'SETTLE' })
          onSuccess?.()
        }
      } else {
        // For web: Use redirect flow
        setOAuthState({ returnContext })
        await redirect(httpClient, provider, oauthRelayUrl)
      }
    } catch (e: unknown) {
      if (!attempt.isCurrent() || identitySignal.aborted) {
        return
      }
      // "Redirecting for OAuth" is thrown intentionally by redirectOAuthFlow to satisfy TypeScript's never return type
      // It's not a real error, so we ignore it
      if (e instanceof Error && e.message === 'Redirecting for OAuth') {
        return
      }
      const message = describeError(e)
      dispatch({ type: 'ERROR', message })
      onError?.(new Error(message, { cause: e }))
    } finally {
      attempt.finish()
    }
  }

  /**
   * Processes OAuth callback data from redirect.
   * Returns true if successful, false otherwise.
   */
  const processCallback = async (callbackData: OAuthCallbackData): Promise<boolean> => {
    const identitySignal = getIdentitySignal()
    const attempt = operation.begin()
    if (!attempt) {
      return false
    }
    try {
      const { code, state: returnedState, error: oauthError } = callbackData
      const oauthState = getOAuthState()
      const { state: storedState, provider, verifier: codeVerifier } = oauthState

      // Unrelated or stale callbacks must not settle the current authorization,
      // including provider-denial callbacks that do not carry an authorization code.
      if (!provider || !returnedState || storedState !== returnedState) {
        return false
      }
      if (oauthError) {
        clearOAuthState()
        dispatch({ type: 'ERROR', message: oauthError })
        onError?.(new Error(oauthError))
        return false
      }
      if (!code || !codeVerifier) {
        return false
      }

      // Claim this one-use callback before yielding. Other mounted consumers
      // cannot redeem it again, and completion cannot erase a newer OAuth flow.
      clearOAuthState()
      dispatch({ type: 'START' })
      try {
        const oauthRelayUrl = oauthState.oauthRelayUrl ?? getIntegrationRelayUrl()
        const tokens = await exchangeTokens(createIntegrationOAuthClient(oauthRelayUrl), provider, code, codeVerifier)
        if (!attempt.isCurrent() || identitySignal.aborted) {
          return false
        }
        const userInfo = await getUser(provider, tokens.access_token)
        if (!attempt.isCurrent() || identitySignal.aborted) {
          return false
        }

        await saveCredentials(provider, tokens, userInfo, oauthRelayUrl, identitySignal)
        if (!attempt.isCurrent() || identitySignal.aborted) {
          return false
        }

        dispatch({ type: 'SETTLE' })
        onSuccess?.()
        return true
      } catch (e: unknown) {
        if (!attempt.isCurrent() || identitySignal.aborted) {
          return false
        }
        const message = describeError(e)
        dispatch({ type: 'ERROR', message })
        onError?.(new Error(message, { cause: e }))
        return false
      }
    } finally {
      attempt.finish()
    }
  }

  const clearError = () => dispatch({ type: 'CLEAR_ERROR' })

  return {
    connect,
    processCallback,
    isConnecting: state.phase === 'connecting',
    error: state.phase === 'error' ? state.message : null,
    clearError,
  }
}

export type { OAuthCallbackData, OAuthDependencies, UseOAuthConnectResult }
