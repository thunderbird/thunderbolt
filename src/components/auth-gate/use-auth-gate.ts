/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useAuth, useHttpClient } from '@/contexts'
import { authRequestHeaders } from '@/contexts/auth-context'
import { isAltchaCaptchaEnabled, isAnonymousAuthEnabled, isSsoMode, isWaitlistBypassed } from '@/lib/auth-mode'
import { captchaTokenHeader, captchaVerificationFailedCode } from '@shared/captcha'
import { AltchaTransientError, solveAltchaChallenge } from './altcha'

export type AuthRequirement = 'authenticated' | 'unauthenticated'

export type AuthGateState =
  | { status: 'loading' }
  | { status: 'allowed' }
  | { status: 'redirect'; to: string }
  | { status: 'verifying' }
  | { status: 'verification-failed'; retry: () => void }

/** Progress of the ALTCHA solve that precedes anonymous sign-in; stays `idle` without a captcha. */
type CaptchaStatus = 'idle' | 'verifying' | 'failed'

/**
 * Hook that determines route access based on authentication state.
 *
 * For `require="authenticated"`:
 *  - has session (real or anonymous) → allowed
 *  - SSO mode + no session → redirect to /sso-redirect, or to /sso-error when `search` carries an SSO `error`
 *  - waitlist bypassed + anonymous overlay enabled + no session → fire `signIn.anonymous()` and show loading
 *    (with `VITE_CAPTCHA_PROVIDER=altcha`, solve a challenge first and show `verifying`, or
 *    `verification-failed` with a retry when the challenge fetch fails or the API refuses the solution)
 *  - waitlist active + no session → redirect to /waitlist
 *
 * For `require="unauthenticated"`:
 *  - has session → redirect to /
 *  - no session → allowed
 *
 * Anonymous users count as "authenticated" for routing — their session has a real
 * `user` record with `isAnonymous: true`. Capability gating per route lives in the
 * route itself, not here.
 *
 * @param search the current location's query string, such as `?error=access_denied`
 */
export const useAuthGate = (require: AuthRequirement, search = ''): AuthGateState => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session, isPending } = authClient.useSession()
  const isAuthenticated = !!session?.user

  const isAnonymousAllowed = isAnonymousAuthEnabled() && !isSsoMode() && isWaitlistBypassed()

  const triedAnonRef = useRef(false)
  // The captcha attempt in flight, if any. A ref because a double click on retry lands before the
  // re-render that hides the button; aborted on unmount so a stale attempt never signs in.
  const attemptRef = useRef<AbortController | null>(null)
  const [anonError, setAnonError] = useState<Error | null>(null)
  const [captchaStatus, setCaptchaStatus] = useState<CaptchaStatus>('idle')
  if (anonError) {
    throw anonError
  }

  /**
   * Solve a fresh challenge and sign in with it. A transient failure of the challenge step
   * (network, fetch timeout, 5xx, worker failure, solve timeout) or a 403 refusing the solution
   * offers a retry; anything else, such as a 4xx on the challenge, throws during render like any
   * failed anonymous sign-in. Only the challenge step's transient failures are retried: a failed
   * sign-in request (network failure or 5xx) throws, as it did before the captcha.
   */
  const solveAndSignIn = async (signal: AbortSignal) => {
    setCaptchaStatus('verifying')
    const token = await solveAltchaChallenge(httpClient, signal).catch((err: unknown) => {
      if (signal.aborted) {
        return null
      }
      if (!(err instanceof AltchaTransientError)) {
        throw err
      }
      console.error('ALTCHA challenge failed:', err)
      return null
    })
    // Cancelled by unmount: the gate is gone, so neither sign in nor touch its state. The solve
    // rejects on abort; this also catches one that resolved just before the abort landed.
    if (signal.aborted) {
      return null
    }
    if (!token) {
      setCaptchaStatus('failed')
      return null
    }
    const result = await authClient.signIn.anonymous({
      fetchOptions: { headers: authRequestHeaders({ [captchaTokenHeader]: token }), signal },
    })
    if (result?.error?.code === captchaVerificationFailedCode) {
      setCaptchaStatus('failed')
      return null
    }
    return result
  }

  /** One captcha attempt at a time; a call while one is in flight is a no-op. */
  const signInWithCaptcha = async () => {
    if (attemptRef.current) {
      return null
    }
    const attempt = new AbortController()
    attemptRef.current = attempt
    try {
      return await solveAndSignIn(attempt.signal)
    } finally {
      if (attemptRef.current === attempt) {
        attemptRef.current = null
      }
    }
  }

  const signInAnonymously = async () => {
    try {
      const result = isAltchaCaptchaEnabled() ? await signInWithCaptcha() : await authClient.signIn.anonymous()
      if (result?.error) {
        setAnonError(new Error(result.error.message ?? 'Anonymous sign-in failed'))
      }
    } catch (err) {
      setAnonError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const fireAnonSignIn = useEffectEvent(() => void signInAnonymously())

  // Strict Mode invokes effects twice on mount; the ref dedups so we never fire
  // signIn.anonymous() more than once per gate mount. Only the captcha retry
  // button signs in again.
  //
  // Better Auth client methods resolve with `{ data, error }` for HTTP failures
  // (4xx/5xx) — they do NOT throw. Only network errors / aborts reject. We must
  // surface both paths to the error boundary; otherwise an HTTP error leaves the
  // gate stuck in `loading` forever (the ref prevents a retry).
  useEffect(() => {
    const shouldFireAnon =
      !isPending && !isAuthenticated && require === 'authenticated' && isAnonymousAllowed && !triedAnonRef.current
    if (!shouldFireAnon) {
      return
    }
    triedAnonRef.current = true
    fireAnonSignIn()
  }, [isPending, isAuthenticated, require, isAnonymousAllowed])

  // Unmount cancels a captcha attempt before it can sign in. It also re-arms the auto sign-in,
  // because Strict Mode's simulated unmount keeps the refs and would otherwise leave nothing running.
  useEffect(
    () => () => {
      if (!attemptRef.current) {
        return
      }
      attemptRef.current.abort()
      attemptRef.current = null
      triedAnonRef.current = false
    },
    [],
  )

  if (isPending) {
    return { status: 'loading' }
  }

  if (require === 'unauthenticated') {
    return isAuthenticated ? { status: 'redirect', to: '/' } : { status: 'allowed' }
  }

  if (isAuthenticated) {
    return { status: 'allowed' }
  }

  if (isAnonymousAllowed) {
    if (captchaStatus === 'failed') {
      return { status: 'verification-failed', retry: () => void signInAnonymously() }
    }
    return captchaStatus === 'verifying' ? { status: 'verifying' } : { status: 'loading' }
  }

  if (isSsoMode()) {
    // Better Auth sends some SSO failures (a SAML account that cannot be linked) to the callback URL, `/`, not to
    // `errorCallbackURL`. Restarting the login from here would loop, as the IdP still holds a session.
    const failedSsoLogin = new URLSearchParams(search).has('error')
    return { status: 'redirect', to: failedSsoLogin ? `/sso-error${search}` : '/sso-redirect' }
  }

  return { status: 'redirect', to: '/waitlist' }
}
