import { useRef } from 'react'
import { useAuth } from '@/contexts'

export type AuthRequirement = 'authenticated' | 'unauthenticated'

export type AuthGateState = { status: 'loading' } | { status: 'allowed' } | { status: 'redirect' }

type ResolvedState = { status: 'allowed' } | { status: 'redirect' }

/**
 * Hook that determines route access based on authentication state.
 * Returns a state object indicating whether to show loading, allow access, or redirect.
 * Once resolved, never returns loading again for this mount so refetches (e.g. tab focus) don't unmount children.
 */
export const useAuthGate = (require: AuthRequirement): AuthGateState => {
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const isAuthenticated = !!session?.user
  const resolvedRef = useRef<ResolvedState | null>(null)

  if (isPending) {
    if (resolvedRef.current) return resolvedRef.current
    return { status: 'loading' }
  }

  if (require === 'authenticated' && !isAuthenticated) {
    resolvedRef.current = { status: 'redirect' }
    return { status: 'redirect' }
  }
  if (require === 'unauthenticated' && isAuthenticated) {
    resolvedRef.current = { status: 'redirect' }
    return { status: 'redirect' }
  }
  resolvedRef.current = { status: 'allowed' }
  return { status: 'allowed' }
}
