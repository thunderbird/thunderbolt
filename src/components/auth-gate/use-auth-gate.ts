/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/contexts'
import { isAnonymousAuthEnabled, isSsoMode } from '@/lib/auth-mode'
import { isPrPreview } from '@/lib/platform'

export type AuthRequirement = 'authenticated' | 'unauthenticated'

export type RedirectTarget = 'sso' | 'waitlist' | 'home'

export type AuthGateState =
  | { status: 'loading' }
  | { status: 'allowed' }
  | { status: 'redirect'; target: RedirectTarget }

const isBypassWaitlistEnabled = () => import.meta.env.VITE_BYPASS_WAITLIST === 'true'

/**
 * Hook that determines route access based on authentication state.
 *
 * For `require="authenticated"`:
 *  - has session (real or anonymous) → allowed
 *  - SSO mode + no session → redirect to /sso-redirect
 *  - waitlist bypassed + anonymous overlay enabled + no session → fire `signIn.anonymous()` and show loading
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
  const { data: session, isPending } = authClient.useSession()
  const isAuthenticated = !!session?.user

  const waitlistBypassed = isPrPreview() || isBypassWaitlistEnabled()
  const anonymousAllowed = isAnonymousAuthEnabled() && !isSsoMode()

  const shouldAutoAnon =
    !isPending && !isAuthenticated && require === 'authenticated' && waitlistBypassed && anonymousAllowed

  const triedAnonRef = useRef(false)
  const [anonError, setAnonError] = useState<Error | null>(null)
  if (anonError) {
    throw anonError
  }

  useEffect(() => {
    if (!shouldAutoAnon || triedAnonRef.current) {
      return
    }
    triedAnonRef.current = true
    authClient.signIn.anonymous().catch(setAnonError)
  }, [shouldAutoAnon, authClient])

  if (isPending) {
    return { status: 'loading' }
  }

  if (require === 'unauthenticated') {
    return isAuthenticated ? { status: 'redirect', target: 'home' } : { status: 'allowed' }
  }

  if (isAuthenticated) {
    return { status: 'allowed' }
  }

  if (isSsoMode()) {
    return { status: 'redirect', target: 'sso' }
  }

  if (shouldAutoAnon) {
    return { status: 'loading' }
  }

  return { status: 'redirect', target: 'waitlist' }
}
