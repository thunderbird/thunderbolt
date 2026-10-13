/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useAuth, useHttpClient } from '@/contexts'
import { authRequestHeaders } from '@/contexts/auth-context'
import { isAltchaCaptchaEnabled, isAnonymousAuthEnabled, isSsoMode, isWaitlistBypassed } from '@/lib/auth-mode'
import { captchaTokenHeader, captchaVerificationFailedCode } from '@shared/captcha'
import { solveAltchaChallenge } from './altcha'

export type AuthRequirement = 'authenticated' | 'unauthenticated'

export type RedirectTarget = 'sso' | 'waitlist' | 'home'

export type AuthGateState =
  | { status: 'loading' }
  | { status: 'allowed' }
  | { status: 'redirect'; target: RedirectTarget }
  | { status: 'verifying' }
  | { status: 'verification-failed'; retry: () => void }

/** Progress of the ALTCHA solve that precedes anonymous sign-in; stays `idle` without a captcha. */
type CaptchaStatus = 'idle' | 'verifying' | 'failed'

/**
 * Hook that determines route access based on authentication state.
 *
 * For `require="authenticated"`:
 *  - has session (real or anonymous) → allowed
 *  - SSO mode + no session → redirect to /sso-redirect
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
 */
export const useAuthGate = (require: AuthRequirement): AuthGateState => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session, isPending } = authClient.useSession()
  const isAuthenticated = !!session?.user

  const isAnonymousAllowed = isAnonymousAuthEnabled() && !isSsoMode() && isWaitlistBypassed()

  const triedAnonRef = useRef(false)
  // A double click on retry lands before the re-render that hides the button, so state cannot guard it.
  const signInInFlightRef = useRef(false)
  const [anonError, setAnonError] = useState<Error | null>(null)
  const [captchaStatus, setCaptchaStatus] = useState<CaptchaStatus>('idle')
  if (anonError) {
    throw anonError
  }

  /** Solve a fresh challenge and sign in with it; a refused solution or failed fetch offers a retry. */
  const signInWithCaptcha = async () => {
    setCaptchaStatus('verifying')
    const token = await solveAltchaChallenge(httpClient).catch((err: unknown) => {
      console.error('ALTCHA challenge failed:', err)
      return null
    })
    if (!token) {
      setCaptchaStatus('failed')
      return null
    }
    const result = await authClient.signIn.anonymous({
      fetchOptions: { headers: authRequestHeaders({ [captchaTokenHeader]: token }) },
    })
    if (result?.error?.code === captchaVerificationFailedCode) {
      setCaptchaStatus('failed')
      return null
    }
    return result
  }

  const signInAnonymously = async () => {
    if (signInInFlightRef.current) {
      return
    }
    signInInFlightRef.current = true
    try {
      const result = isAltchaCaptchaEnabled() ? await signInWithCaptcha() : await authClient.signIn.anonymous()
      if (result?.error) {
        setAnonError(new Error(result.error.message ?? 'Anonymous sign-in failed'))
      }
    } catch (err) {
      setAnonError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      signInInFlightRef.current = false
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

  if (isPending) {
    return { status: 'loading' }
  }

  if (require === 'unauthenticated') {
    return isAuthenticated ? { status: 'redirect', target: 'home' } : { status: 'allowed' }
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
    return { status: 'redirect', target: 'sso' }
  }

  return { status: 'redirect', target: 'waitlist' }
}
