import { useAuth } from '@/contexts'

export type AuthRequirement = 'authenticated' | 'unauthenticated'

export type AuthGateState = { status: 'loading' } | { status: 'allowed' } | { status: 'redirect' }

/**
 * Hook that determines route access based on authentication state.
 * Returns a state object indicating whether to show loading, allow access, or redirect.
 */
export const useAuthGate = (require: AuthRequirement): AuthGateState => {
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const isAuthenticated = !!session?.user

  if (isPending) return { status: 'loading' }

  if (require === 'authenticated' && !isAuthenticated) return { status: 'redirect' }
  if (require === 'unauthenticated' && isAuthenticated) return { status: 'redirect' }

  return { status: 'allowed' }
}
