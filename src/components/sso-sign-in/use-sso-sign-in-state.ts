/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useReducer, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/contexts'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { appVersionHeader } from '@/lib/app-version'
import { setAuthToken } from '@/lib/auth-token'
import { http, HttpError } from '@/lib/http'
import { isTauri } from '@/lib/platform'
import { SsoCallbackError, startSsoFlowLoopback } from '@/lib/sso-loopback'
import { ssoEmailCodePath } from '@/lib/sso-paths'
import { isSafeUrl, normalizeBackendUrl } from '@/lib/url-utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

/** A connection the login screen can offer, as `POST /v1/sso/discover` returns it. */
export type SsoConnectionOption = { providerId: string; name: string }

/** The provider servers from before SSO connections expose, under the same id. */
const legacyProviderId = 'sso'

type Status = 'waiting-for-session' | 'discovering' | 'email' | 'choose' | 'redirecting' | 'error'

type State = { status: Status; email: string; connections: SsoConnectionOption[]; attempt: number }

type Action =
  | { type: 'askEmail' }
  | { type: 'setEmail'; email: string }
  | { type: 'discovering' }
  | { type: 'choose'; connections: SsoConnectionOption[] }
  | { type: 'redirecting' }
  | { type: 'fail' }
  | { type: 'retry' }

const initialState: State = { status: 'waiting-for-session', email: '', connections: [], attempt: 0 }

/** The SSO sign-in flow's steps, from waiting for the session to the redirect. */
const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'discovering':
      return { ...state, status: 'discovering' }
    case 'askEmail':
      return { ...state, status: 'email' }
    case 'setEmail':
      return { ...state, email: action.email }
    case 'choose':
      return { ...state, status: 'choose', connections: action.connections }
    case 'redirecting':
      return { ...state, status: 'redirecting' }
    case 'fail':
      return { ...state, status: 'error' }
    case 'retry':
      return { ...state, status: 'discovering', attempt: state.attempt + 1 }
  }
}

/** Is this a server from before SSO connections, which has no discovery route? */
const isMissingRoute = (error: unknown) => error instanceof HttpError && error.response.status === 404

/**
 * State for the SSO sign-in screen. With one connection it goes straight to the identity
 * provider, as a single-provider deployment always has. With several it asks for the email,
 * goes straight to the connection that claims its domain, and otherwise offers one button per
 * connection. The email-code path stays open for people no identity provider manages.
 *
 * On Tauri desktop, uses the system browser + loopback server pattern instead of navigating the
 * webview (WKWebView drops cookies during cross-origin redirects).
 */
export const useSsoSignInState = () => {
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const analytics = useAnonymousPromotionAnalytics()
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, initialState)
  const signInController = useRef<AbortController | null>(null)
  const normalizedCloudUrl = normalizeBackendUrl(cloudUrl)
  const baseUrl = normalizedCloudUrl.replace(/\/v1$/, '')
  // A signed-out session becomes pending again on reconnect. Only wait for its
  // first resolution; background refetches must not restart an active sign-in.
  const isSessionReady = state.status !== 'waiting-for-session' || !isPending

  const discover = async (signal: AbortSignal, email?: string) => {
    try {
      const { connections } = await http
        .post(`${baseUrl}/v1/sso/discover`, { json: email ? { email } : {}, headers: appVersionHeader(), signal })
        .json<{ connections: SsoConnectionOption[] }>()
      return connections
    } catch (err) {
      if (isMissingRoute(err)) {
        return [{ providerId: legacyProviderId, name: '' }]
      }
      throw err
    }
  }

  const signIn = async (providerId: string, signal: AbortSignal) => {
    dispatch({ type: 'redirecting' })

    // Tauri desktop: use system browser + loopback server (RFC 8252)
    if (isTauri()) {
      analytics.persistForSso()
      const token = await startSsoFlowLoopback(baseUrl, providerId)
      if (signal.aborted) {
        return
      }
      if (token) {
        setAuthToken(token, cloudUrl)
        window.location.replace('/')
      } else {
        dispatch({ type: 'fail' }) // timeout
      }
      return
    }

    // Web: redirect the browser to the IdP
    const data = await http
      .post(`${baseUrl}/v1/api/auth/sign-in/sso`, {
        json: {
          providerId,
          callbackURL: window.location.origin + '/',
          errorCallbackURL: window.location.origin + '/sso-error',
        },
        credentials: 'include',
        signal,
      })
      .json<{ url: string }>()

    if (signal.aborted) {
      return
    }

    if (!isSafeUrl(data.url)) {
      console.error('SSO redirect blocked: unsafe URL', data.url)
      dispatch({ type: 'fail' })
      return
    }

    // Persist only the conversion marker before the browser navigates away.
    analytics.persistForSso()
    window.location.href = data.url
  }

  /** Run one step of the sign-in, sending its failures to the error state or page. */
  const run = async (step: (signal: AbortSignal) => Promise<void>) => {
    const signal = signInController.current?.signal
    if (!signal || signal.aborted) {
      return
    }
    try {
      await step(signal)
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return
      }
      if (err instanceof SsoCallbackError) {
        window.location.replace(`/sso-error?error=${encodeURIComponent(err.code)}`)
        return
      }
      console.error('SSO sign-in failed:', err)
      dispatch({ type: 'fail' })
    }
  }

  /** Continue with what discovery offered: the only connection, or a choice. */
  const offer = (connections: SsoConnectionOption[], signal: AbortSignal, onSeveral: () => void) => {
    if (connections.length === 0) {
      dispatch({ type: 'fail' })
      return
    }
    if (connections.length === 1) {
      return signIn(connections[0].providerId, signal)
    }
    onSeveral()
  }

  const begin = useEffectEvent(() =>
    run(async (signal) => {
      // AuthGate already resolved this session on normal entry. Direct visits
      // wait below, so analytics never adds another request before sign-in.
      await analytics.captureAnonymousSession(authClient, session)
      if (signal.aborted) {
        return
      }
      const connections = await discover(signal)
      if (signal.aborted) {
        return
      }
      await offer(connections, signal, () => dispatch({ type: 'askEmail' }))
    }),
  )

  useEffect(() => {
    if (!isSessionReady) {
      return
    }
    dispatch({ type: 'discovering' })
    const controller = new AbortController()
    signInController.current = controller
    void begin()

    return () => controller.abort()
  }, [normalizedCloudUrl, state.attempt, isSessionReady])

  const submitEmail = () =>
    run(async (signal) => {
      dispatch({ type: 'discovering' })
      const connections = await discover(signal, state.email.trim())
      if (signal.aborted) {
        return
      }
      await offer(connections, signal, () => dispatch({ type: 'choose', connections }))
    })

  return {
    state,
    actions: {
      setEmail: (email: string) => dispatch({ type: 'setEmail', email }),
      submitEmail,
      chooseConnection: (providerId: string) => run((signal) => signIn(providerId, signal)),
      retry: () => dispatch({ type: 'retry' }),
      goToEmailCode: () => navigate(ssoEmailCodePath, { state: { email: state.email.trim() } }),
    },
  }
}
