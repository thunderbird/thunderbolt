/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts'
import { getAuthToken } from '@/lib/auth-token'

export type AnonymousSessionGuardState = { status: 'loading' } | { status: 'ready' }

/**
 * Ensures a session exists for whoever reaches a child route — creates an anonymous
 * session via Better Auth when none is found. Intentionally ignorant of waitlist,
 * SSO mode, and any other access-gate concerns; those live in `AuthGate` upstream.
 *
 * Token-first: if a stored auth token exists, treat the user as effectively
 * authenticated and skip the anonymous-create (mirrors `useAuthGate`).
 *
 * Failure is silent by design — downstream features that need the backend
 * (chat, sync, etc.) raise their own errors when invoked without a session.
 */
export const useAnonymousSessionGuard = (): AnonymousSessionGuardState => {
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const hasToken = Boolean(getAuthToken())
  const [hasAttempted, setHasAttempted] = useState(false)

  useEffect(() => {
    if (isPending || session?.user || hasToken || hasAttempted) {
      return
    }
    void (async () => {
      try {
        await authClient.signIn.anonymous()
      } catch {
        // silent failure by design — downstream features surface their own errors
      } finally {
        setHasAttempted(true)
      }
    })()
  }, [isPending, session?.user, hasToken, hasAttempted, authClient])

  if (isPending && !hasToken && !session?.user) {
    return { status: 'loading' }
  }
  // "About to fire" or "currently firing" — both derive from observable state during
  // render, eliminating the mount→unmount→remount gap caused by deferring this decision
  // to the post-commit effect.
  if (!hasAttempted && !session?.user && !hasToken) {
    return { status: 'loading' }
  }
  return { status: 'ready' }
}
