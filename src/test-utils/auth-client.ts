import type { AuthClient } from '@/contexts'

type MockAuthClientOptions = {
  session?: {
    user: {
      id: string
      email: string
      name?: string
    }
  } | null
  isPending?: boolean
  signInMagicLink?: (options: { email: string; callbackURL: string }) => Promise<{ error: { message: string } | null }>
  signOut?: () => Promise<void>
}

/**
 * Creates a mock auth client for testing
 * Default state is logged out (session: null, isPending: false)
 */
export const createMockAuthClient = (options: MockAuthClientOptions = {}): AuthClient => {
  const {
    session = null,
    isPending = false,
    signInMagicLink = async () => ({ error: null }),
    signOut = async () => {},
  } = options

  // Use unknown first to bypass strict type checking for test mocks
  return {
    useSession: () => ({
      data: session,
      isPending,
      isRefetching: false,
      error: null,
      refetch: async () => ({ data: session, error: null }),
    }),
    signIn: {
      magicLink: signInMagicLink,
    },
    signOut,
    $Infer: {} as AuthClient['$Infer'],
  } as unknown as AuthClient
}
