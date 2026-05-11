/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/contexts'
import { getAuthToken } from '@/lib/auth-token'

type Phase = 'idle' | 'trying' | 'done'

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
  const triedRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('idle')

  useEffect(() => {
    if (triedRef.current || isPending || session?.user || hasToken) {
      return
    }
    triedRef.current = true
    setPhase('trying')
    // Silent failure by design — downstream features (chat etc.) surface their own
    // errors when invoked without a session. The catch covers thrown rejections;
    // Better Auth's resolved `{ error }` path is also intentionally a no-op here.
    void (async () => {
      try {
        await authClient.signIn.anonymous()
      } catch {
        // intentional no-op
      } finally {
        setPhase('done')
      }
    })()
  }, [isPending, session?.user, hasToken, authClient])

  if (phase === 'trying') {
    return { status: 'loading' }
  }
  if (isPending && !hasToken && !session?.user) {
    return { status: 'loading' }
  }
  return { status: 'ready' }
}
