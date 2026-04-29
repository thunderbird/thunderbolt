/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import { useAuth } from '@/contexts'
import { getAuthToken } from '@/lib/auth-token'

export type AuthRequirement = 'authenticated' | 'unauthenticated'

export type AuthGateState = { status: 'loading' } | { status: 'allowed' } | { status: 'redirect' }

type ResolvedState = { status: 'allowed' } | { status: 'redirect' }

/**
 * Hook that determines route access based on authentication state.
 * Returns a state object indicating whether to show loading, allow access, or redirect.
 * Once resolved, never returns loading again for this mount so refetches (e.g. tab focus) don't unmount children.
 *
 * Token-first: if a local auth token exists, the user is treated as optimistically authenticated
 * during pending/loading states and when the session fetch fails (e.g. network error).
 * The token is only cleared on a 401 response (see auth-context.tsx onError handler).
 */
export const useAuthGate = (require: AuthRequirement): AuthGateState => {
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const isAuthenticated = !!session?.user
  const hasToken = Boolean(getAuthToken())
  const resolvedRef = useRef<ResolvedState | null>(null)

  const effectivelyAuthenticated = isAuthenticated || hasToken
  const matchesRequirement = require === 'authenticated' ? effectivelyAuthenticated : !effectivelyAuthenticated

  if (isPending) {
    if (matchesRequirement) {
      return { status: 'allowed' }
    }
    return resolvedRef.current ?? { status: 'loading' }
  }

  const result: ResolvedState = matchesRequirement ? { status: 'allowed' } : { status: 'redirect' }
  resolvedRef.current = result
  return result
}
